import { describe, expect, it, vi } from "vitest";
import type { JobDoc } from "../../shared/types.js";
import { CompositePoster, type NotificationPoster } from "./poster.js";

function mockPoster(name: string): NotificationPoster & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async postQueued() {
      calls.push(`${name}:postQueued`);
    },
    async postClaimed() {
      calls.push(`${name}:postClaimed`);
    },
    async postDone() {
      calls.push(`${name}:postDone`);
    },
    async postFailed() {
      calls.push(`${name}:postFailed`);
    },
    async postCanceled() {
      calls.push(`${name}:postCanceled`);
    },
    async postPlan() {
      calls.push(`${name}:postPlan`);
    },
    async postEvent(_job: JobDoc, type: string) {
      calls.push(`${name}:postEvent:${type}`);
    },
    async setPresenceActive() {
      calls.push(`${name}:active`);
    },
    async setPresenceAway() {
      calls.push(`${name}:away`);
    },
  };
}

const fakeJob = { task_id: "test-123" } as JobDoc;

describe("CompositePoster", () => {
  it("fans out to all registered posters", async () => {
    const p1 = mockPoster("slack");
    const p2 = mockPoster("discord");
    const composite = new CompositePoster();
    composite.add(p1);
    composite.add(p2);

    await composite.postQueued(fakeJob);
    await composite.postDone(fakeJob);
    await composite.postEvent(fakeJob, "PR_CREATED", {});

    expect(p1.calls).toEqual(["slack:postQueued", "slack:postDone", "slack:postEvent:PR_CREATED"]);
    expect(p2.calls).toEqual([
      "discord:postQueued",
      "discord:postDone",
      "discord:postEvent:PR_CREATED",
    ]);
  });

  it("continues if one poster throws", async () => {
    const failing: NotificationPoster = {
      async postQueued() {
        throw new Error("boom");
      },
      async postClaimed() {},
      async postDone() {},
      async postFailed() {},
      async postCanceled() {},
      async postPlan() {},
      async postEvent() {},
      async setPresenceActive() {},
      async setPresenceAway() {},
    };
    const p2 = mockPoster("discord");
    const composite = new CompositePoster();
    composite.add(failing);
    composite.add(p2);

    // Should not throw
    await composite.postQueued(fakeJob);
    expect(p2.calls).toEqual(["discord:postQueued"]);
  });

  it("works with no posters registered", async () => {
    const composite = new CompositePoster();
    // Should not throw
    await composite.postQueued(fakeJob);
    await composite.setPresenceActive();
  });

  it("fans out presence calls", async () => {
    const p1 = mockPoster("slack");
    const p2 = mockPoster("discord");
    const composite = new CompositePoster();
    composite.add(p1);
    composite.add(p2);

    await composite.setPresenceActive();
    await composite.setPresenceAway();

    expect(p1.calls).toEqual(["slack:active", "slack:away"]);
    expect(p2.calls).toEqual(["discord:active", "discord:away"]);
  });
});
