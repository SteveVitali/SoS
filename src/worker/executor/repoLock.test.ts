import { afterEach, describe, expect, it } from "vitest";
import { _getQueueDepth, _isHeld, _resetAll, withRepoLock } from "./repoLock.js";

describe("repoLock", () => {
  afterEach(() => {
    _resetAll();
  });

  it("runs the callback immediately when lock is free", async () => {
    const result = await withRepoLock("repo-a", () => 42);
    expect(result).toBe(42);
  });

  it("returns the callback's async result", async () => {
    const result = await withRepoLock("repo-a", async () => {
      return "hello";
    });
    expect(result).toBe("hello");
  });

  it("serializes concurrent calls for the same repo", async () => {
    const order: number[] = [];
    let resolve1!: () => void;
    const gate1 = new Promise<void>((r) => {
      resolve1 = r;
    });

    // First call: holds the lock until gate1 resolves
    const p1 = withRepoLock("repo-a", async () => {
      order.push(1);
      await gate1;
      order.push(2);
      return "first";
    });

    // Second call: should queue behind the first
    const p2 = withRepoLock("repo-a", async () => {
      order.push(3);
      return "second";
    });

    // At this point, only the first callback should have started
    // Wait a tick to let microtasks settle
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1]);
    expect(_isHeld("repo-a")).toBe(true);
    expect(_getQueueDepth("repo-a")).toBe(1);

    // Release the gate — first completes, then second runs
    resolve1();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe("first");
    expect(r2).toBe("second");
    expect(order).toEqual([1, 2, 3]);
    expect(_isHeld("repo-a")).toBe(false);
    expect(_getQueueDepth("repo-a")).toBe(0);
  });

  it("allows concurrent calls for different repos", async () => {
    const order: string[] = [];
    let resolveA!: () => void;
    const gateA = new Promise<void>((r) => {
      resolveA = r;
    });

    const pA = withRepoLock("repo-a", async () => {
      order.push("a-start");
      await gateA;
      order.push("a-end");
    });

    const pB = withRepoLock("repo-b", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    // B should complete immediately since it's a different repo
    await pB;
    expect(order).toContain("b-start");
    expect(order).toContain("b-end");

    resolveA();
    await pA;
    expect(order).toContain("a-end");
  });

  it("releases the lock even if the callback throws", async () => {
    await expect(
      withRepoLock("repo-a", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Lock should be released — a subsequent call should succeed
    expect(_isHeld("repo-a")).toBe(false);
    const result = await withRepoLock("repo-a", () => "ok");
    expect(result).toBe("ok");
  });

  it("processes a queue of 3 waiters in order", async () => {
    const order: number[] = [];
    const gates: Array<() => void> = [];

    function makeGate(): Promise<void> {
      return new Promise<void>((r) => gates.push(r));
    }

    const p1 = withRepoLock("repo-a", async () => {
      order.push(1);
      await makeGate();
    });
    const p2 = withRepoLock("repo-a", async () => {
      order.push(2);
      await makeGate();
    });
    const p3 = withRepoLock("repo-a", async () => {
      order.push(3);
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1]);
    expect(_getQueueDepth("repo-a")).toBe(2);

    gates[0](); // release first
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1, 2]);
    expect(_getQueueDepth("repo-a")).toBe(1);

    gates[1](); // release second
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});
