import { execSync } from "node:child_process";
import { TtlCache } from "../../shared/cache.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("server:github:teamCache");

const teamCache = new TtlCache<string[]>({ ttlMs: 5 * 60 * 1000, label: "github-team-members" });

function gh(cmd: string): string {
  return execSync(`gh ${cmd}`, { encoding: "utf-8", timeout: 30_000 }).trim();
}

/** Resolve the authenticated GitHub username. Cached for the process lifetime. */
let cachedUsername: string | null = null;
export function getAuthenticatedUser(): string {
  if (cachedUsername) return cachedUsername;
  try {
    const raw = gh("api user --jq .login");
    cachedUsername = raw;
    log.info("Resolved GitHub username", { username: raw });
    return raw;
  } catch (err: any) {
    log.warn("Failed to resolve GitHub username via gh api", { error: err.message });
    throw new Error(
      "Could not determine GitHub username. Set SOS_GITHUB_USERNAME or run `gh auth login`.",
    );
  }
}

/** Fetch team members for an org/team via the GitHub Teams API. Results are cached for 5 minutes. */
export function getTeamMembers(org: string, teamSlug: string): string[] {
  const key = `${org}/${teamSlug}`;
  return teamCache.getOrSet(key, () => {
    try {
      const raw = gh(`api "/orgs/${org}/teams/${teamSlug}/members" --jq ".[].login" --paginate`);
      const members = raw
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      log.info("Fetched team members", { org, teamSlug, count: members.length });
      return members;
    } catch (err: any) {
      log.error("Failed to fetch team members", { org, teamSlug, error: err.message });
      throw new Error(
        `Could not fetch team members for ${org}/${teamSlug}. ` +
          "Ensure you have org access and SOS_GITHUB_ORG / SOS_GITHUB_TEAM_SLUG are correct.",
      );
    }
  });
}

/** Invalidate the team member cache (useful for testing). */
export function clearTeamCache(): void {
  teamCache.clear();
}
