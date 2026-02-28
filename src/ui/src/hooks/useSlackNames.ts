import { useEffect, useState } from "react";
import { resolveSlackUsers, type SlackUser } from "../api.js";
import { isSlackId } from "../utils/format.js";

const slackNameCache = new Map<string, SlackUser>();
const pendingIds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

function requestSlackResolve(ids: string[]) {
  for (const id of ids) {
    if (isSlackId(id) && !slackNameCache.has(id)) {
      pendingIds.add(id);
    }
  }
  if (pendingIds.size > 0 && !flushTimer) {
    flushTimer = setTimeout(async () => {
      const batch = [...pendingIds];
      pendingIds.clear();
      flushTimer = null;
      try {
        const resolved = await resolveSlackUsers(batch);
        for (const [id, user] of Object.entries(resolved)) {
          slackNameCache.set(id, user);
        }
        // biome-ignore lint/suspicious/useIterableCallbackReturn: forEach used for side effects
        subscribers.forEach((cb) => cb());
      } catch (err) {
        console.error("Slack user resolution failed:", err);
      }
    }, 50);
  }
}

export function getSlackNameCache(): Map<string, SlackUser> {
  return slackNameCache;
}

export function useSlackNames(ids: string[]) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);
  useEffect(() => {
    requestSlackResolve(ids);
  }, [ids]);
}
