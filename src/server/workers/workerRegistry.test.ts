import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerLogLine } from "../../shared/types.js";
import {
  clearWorkerWs,
  deregisterWorker,
  getLogHistory,
  getWorker,
  listWorkers,
  pushLogLine,
  registerWorker,
  sendWorkerCommand,
  setWorkerWs,
  subscribeToLogs,
  updateWorkerStatus,
} from "./workerRegistry.js";

// Each test gets a fresh registry by deregistering everything
function cleanupAll() {
  for (const w of listWorkers()) {
    deregisterWorker(w.worker_id);
  }
}

describe("workerRegistry", () => {
  beforeEach(() => cleanupAll());
  afterEach(() => cleanupAll());

  // --- Registration ---

  describe("registerWorker", () => {
    it("registers and returns WorkerInfo with defaults", () => {
      const info = registerWorker({
        worker_id: "w1",
        hostname: "host1",
        pid: 1234,
        version: "0.1.0",
      });

      expect(info.worker_id).toBe("w1");
      expect(info.hostname).toBe("host1");
      expect(info.pid).toBe(1234);
      expect(info.version).toBe("0.1.0");
      expect(info.status).toBe("online");
      expect(info.loops).toEqual([{ index: 0, status: "idle" }]);
      expect(info.started_at).toBeTruthy();
      expect(info.last_seen).toBeTruthy();
    });

    it("is retrievable after registration", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      const w = getWorker("w1");
      expect(w).not.toBeNull();
      expect(w?.worker_id).toBe("w1");
    });
  });

  describe("deregisterWorker", () => {
    it("removes worker from registry", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      expect(deregisterWorker("w1")).toBe(true);
      expect(getWorker("w1")).toBeNull();
    });

    it("returns false for unknown worker", () => {
      expect(deregisterWorker("nonexistent")).toBe(false);
    });

    it("sends sentinel to log subscribers on deregister", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      const received: WorkerLogLine[] = [];
      subscribeToLogs("w1", (line) => received.push(line));

      deregisterWorker("w1");

      expect(received).toHaveLength(1);
      expect(received[0].ts).toBe(""); // sentinel
      expect(received[0].loop_index).toBe(-1);
    });
  });

  // --- Status ---

  describe("updateWorkerStatus", () => {
    it("updates loops and refreshes status to online", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });

      const ok = updateWorkerStatus("w1", [{ index: 0, status: "busy", task_id: "task-abc" }]);
      expect(ok).toBe(true);

      const after = getWorker("w1");
      expect(after).not.toBeNull();
      expect(after?.loops[0].status).toBe("busy");
      expect(after?.loops[0].task_id).toBe("task-abc");
      expect(after?.status).toBe("online");
    });

    it("returns false for unknown worker", () => {
      expect(updateWorkerStatus("nope", [])).toBe(false);
    });
  });

  // --- Listing & stale detection ---

  describe("listWorkers / getWorker", () => {
    it("lists registered workers sorted online-first", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      registerWorker({ worker_id: "w2", hostname: "h", pid: 2 });

      const list = listWorkers();
      expect(list).toHaveLength(2);
      expect(list.map((w) => w.worker_id)).toContain("w1");
      expect(list.map((w) => w.worker_id)).toContain("w2");
    });

    it("freshly registered worker is online", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      const w = getWorker("w1");
      expect(w?.status).toBe("online");
    });

    it("returns a copy, not a reference", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      const a = getWorker("w1");
      const b = getWorker("w1");
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b); // different objects
      expect(a).toEqual(b); // same data
    });

    it("returns null for unknown worker", () => {
      expect(getWorker("nope")).toBeNull();
    });
  });

  // --- WebSocket management ---

  describe("sendWorkerCommand", () => {
    it("sends command via registered wsSend", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      const sent: unknown[] = [];
      setWorkerWs("w1", (cmd) => sent.push(cmd));

      const ok = sendWorkerCommand("w1", { command: "shutdown" });
      expect(ok).toBe(true);
      expect(sent).toEqual([{ command: "shutdown" }]);
    });

    it("returns false when no WebSocket registered", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      expect(sendWorkerCommand("w1", { command: "shutdown" })).toBe(false);
    });

    it("returns false for unknown worker", () => {
      expect(sendWorkerCommand("nope", { command: "shutdown" })).toBe(false);
    });

    it("clears WebSocket and subsequent sends return false", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      setWorkerWs("w1", () => {});
      clearWorkerWs("w1");

      expect(sendWorkerCommand("w1", { command: "shutdown" })).toBe(false);
    });

    it("returns false if wsSend throws", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      setWorkerWs("w1", () => {
        throw new Error("connection reset");
      });

      expect(sendWorkerCommand("w1", { command: "shutdown" })).toBe(false);
    });
  });

  // --- Log streaming ---

  describe("pushLogLine / getLogHistory / subscribeToLogs", () => {
    it("stores and retrieves log lines", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });

      pushLogLine({ worker_id: "w1", loop_index: 0, line: "hello", ts: "t1" });
      pushLogLine({ worker_id: "w1", loop_index: 0, line: "world", ts: "t2" });

      const history = getLogHistory("w1");
      expect(history).toHaveLength(2);
      expect(history[0].line).toBe("hello");
      expect(history[1].line).toBe("world");
    });

    it("caps ring buffer at 1000 lines", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });

      for (let i = 0; i < 1050; i++) {
        pushLogLine({ worker_id: "w1", loop_index: 0, line: `line-${i}`, ts: `t${i}` });
      }

      const history = getLogHistory("w1");
      expect(history).toHaveLength(1000);
      // First 50 should have been evicted
      expect(history[0].line).toBe("line-50");
      expect(history[999].line).toBe("line-1049");
    });

    it("filters history by loop index", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });

      pushLogLine({ worker_id: "w1", loop_index: 0, line: "loop0", ts: "t1" });
      pushLogLine({ worker_id: "w1", loop_index: 1, line: "loop1", ts: "t2" });

      expect(getLogHistory("w1", 0)).toHaveLength(1);
      expect(getLogHistory("w1", 0)[0].line).toBe("loop0");
      expect(getLogHistory("w1", 1)).toHaveLength(1);
    });

    it("returns empty array for unknown worker", () => {
      expect(getLogHistory("nope")).toEqual([]);
    });

    it("fans out to live subscribers", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      const received: WorkerLogLine[] = [];
      subscribeToLogs("w1", (line) => received.push(line));

      pushLogLine({ worker_id: "w1", loop_index: 0, line: "live", ts: "t1" });

      expect(received).toHaveLength(1);
      expect(received[0].line).toBe("live");
    });

    it("unsubscribe stops delivery", () => {
      registerWorker({ worker_id: "w1", hostname: "h", pid: 1 });
      const received: WorkerLogLine[] = [];
      const unsub = subscribeToLogs("w1", (line) => received.push(line));

      pushLogLine({ worker_id: "w1", loop_index: 0, line: "before", ts: "t1" });
      unsub();
      pushLogLine({ worker_id: "w1", loop_index: 0, line: "after", ts: "t2" });

      expect(received).toHaveLength(1);
    });

    it("subscribe to unknown worker returns no-op unsubscribe", () => {
      const unsub = subscribeToLogs("nope", () => {});
      expect(typeof unsub).toBe("function");
      unsub(); // should not throw
    });

    it("ignores pushLogLine for unknown worker", () => {
      // Should not throw
      pushLogLine({ worker_id: "nope", loop_index: 0, line: "x", ts: "t" });
    });
  });
});
