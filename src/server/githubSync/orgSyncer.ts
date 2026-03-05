/**
 * OrgSyncer — syncs GitHub org teams and members via REST API.
 * Warm-tier task: runs every 15-30 minutes.
 */

import type { GitHubTeam } from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import { getOrgMembersCollection, getTeamsCollection, upsertTeam } from "./githubRepo.js";
import { getOctokit, getRateLimitBudget, updateBudgetFromResponse } from "./octokitClient.js";
import { writeSyncLog } from "./syncEventLog.js";

const log = createLogger("github:orgSyncer");

/**
 * Sync all teams for an org.
 * Uses GET /orgs/{org}/teams with pagination.
 */
export async function syncOrgTeams(token: string, org: string): Promise<number> {
  org = org.toLowerCase();
  const octokit = getOctokit(token);
  const budget = getRateLimitBudget();
  const startTime = Date.now();
  let teamCount = 0;

  try {
    const teams = await octokit.paginate(
      octokit.teams.list,
      { org, per_page: 100 },
      (response: any) => {
        updateBudgetFromResponse(response, budget);
        return response.data;
      },
    );

    for (const team of teams) {
      const doc: GitHubTeam = {
        _id: `${org}/${team.slug}`,
        org,
        slug: team.slug,
        name: team.name,
        description: team.description || undefined,
        parent_slug: (team as any).parent?.slug || undefined,
        member_count: (team as any).members_count ?? 0,
        synced_at: new Date(),
      };
      await upsertTeam(doc);
      teamCount++;
    }

    await writeSyncLog("info", "org_sync", `Synced ${teamCount} teams for ${org}`, {
      items_fetched: teamCount,
      duration_ms: Date.now() - startTime,
    });

    return teamCount;
  } catch (err: unknown) {
    const msg = (err as Error).message;
    log.error("Failed to sync org teams", { org, error: msg });
    await writeSyncLog("error", "org_sync", `Failed to sync teams: ${msg}`, {
      error: msg,
    });
    throw err;
  }
}

/**
 * Sync members for a specific team.
 * Uses GET /orgs/{org}/teams/{team_slug}/members with pagination.
 * If ancestorSlugs is provided, those slugs are also added to each member's
 * teams array so that querying a parent team returns child-team members too.
 */
export async function syncTeamMembers(
  token: string,
  org: string,
  teamSlug: string,
  ancestorSlugs: string[] = [],
): Promise<string[]> {
  org = org.toLowerCase();
  const octokit = getOctokit(token);
  const budget = getRateLimitBudget();
  const memberLogins: string[] = [];

  // All slugs this member should be tagged with (own + ancestors)
  const allSlugs = [teamSlug, ...ancestorSlugs];

  try {
    const members = await octokit.paginate(
      octokit.teams.listMembersInOrg,
      { org, team_slug: teamSlug, per_page: 100 },
      (response: any) => {
        updateBudgetFromResponse(response, budget);
        return response.data;
      },
    );

    for (const member of members) {
      const login = member.login.toLowerCase();
      memberLogins.push(login);

      // Atomic upsert: always update base fields, $addToSet all relevant team slugs
      await getOrgMembersCollection().updateOne(
        { _id: login as any },
        {
          $set: {
            login: member.login,
            avatar_url: member.avatar_url || "",
            org,
            synced_at: new Date(),
            ...((member as any).name ? { name: (member as any).name } : {}),
          },
          $addToSet: { teams: { $each: allSlugs } },
          $setOnInsert: { _id: login },
        } as any,
        { upsert: true },
      );
    }

    if (members.length > 0) {
      log.info("Synced team members", { org, teamSlug, count: members.length });
    }

    return memberLogins;
  } catch (err: unknown) {
    log.error("Failed to sync team members", { org, teamSlug, error: (err as Error).message });
    throw err;
  }
}

/**
 * Sync all org members (not just team members).
 * Uses GET /orgs/{org}/members with pagination.
 */
export async function syncOrgMembers(token: string, org: string): Promise<number> {
  org = org.toLowerCase();
  const octokit = getOctokit(token);
  const budget = getRateLimitBudget();
  const startTime = Date.now();
  let memberCount = 0;

  try {
    const members = await octokit.paginate(
      octokit.orgs.listMembers,
      { org, per_page: 100 },
      (response: any) => {
        updateBudgetFromResponse(response, budget);
        return response.data;
      },
    );

    for (const member of members) {
      const login = member.login.toLowerCase();

      // Atomic upsert: update base fields, preserve name/teams on existing docs
      await getOrgMembersCollection().updateOne(
        { _id: login as any },
        {
          $set: {
            login: member.login,
            avatar_url: member.avatar_url || "",
            org,
            synced_at: new Date(),
          },
          $setOnInsert: { _id: login, name: undefined, teams: [] },
        } as any,
        { upsert: true },
      );
      memberCount++;
    }

    await writeSyncLog("info", "org_sync", `Synced ${memberCount} org members for ${org}`, {
      items_fetched: memberCount,
      duration_ms: Date.now() - startTime,
    });

    return memberCount;
  } catch (err: unknown) {
    const msg = (err as Error).message;
    log.error("Failed to sync org members", { org, error: msg });
    await writeSyncLog("error", "org_sync", `Failed to sync org members: ${msg}`, {
      error: msg,
    });
    throw err;
  }
}

/**
 * Build a map from team slug → list of ancestor slugs (parent, grandparent, …).
 */
function buildAncestorMap(teams: GitHubTeam[]): Map<string, string[]> {
  const parentOf = new Map<string, string>();
  for (const t of teams) {
    if (t.parent_slug) parentOf.set(t.slug, t.parent_slug);
  }
  const cache = new Map<string, string[]>();
  function ancestors(slug: string): string[] {
    if (cache.has(slug)) return cache.get(slug)!;
    const parent = parentOf.get(slug);
    if (!parent) {
      cache.set(slug, []);
      return [];
    }
    const result = [parent, ...ancestors(parent)];
    cache.set(slug, result);
    return result;
  }
  for (const t of teams) ancestors(t.slug);
  return cache;
}

/**
 * Full org sync: teams, then members per team, then all org members.
 */
export async function syncOrg(token: string, org: string): Promise<void> {
  org = org.toLowerCase();
  const startTime = Date.now();
  log.info("Starting full org sync", { org });

  // 1. Sync teams
  const teamCount = await syncOrgTeams(token, org);

  // 2. Reset all team membership arrays so removed members and stale slugs are cleaned up
  await getOrgMembersCollection().updateMany({ org } as any, { $set: { teams: [] } });

  // 3. Sync members for each team, propagating parent team slugs
  const teams = await getTeamsCollection().find({ org }).toArray();
  const ancestorMap = buildAncestorMap(teams);
  for (const team of teams) {
    const ancestorSlugs = ancestorMap.get(team.slug) || [];
    const memberLogins = await syncTeamMembers(token, org, team.slug, ancestorSlugs);
    // Update team's member_count with actual synced count
    await getTeamsCollection().updateOne(
      { _id: team._id },
      { $set: { member_count: memberLogins.length } },
    );
  }

  // 4. Sync all org members (catches people not in any team)
  const orgMemberCount = await syncOrgMembers(token, org);

  await writeSyncLog(
    "info",
    "org_sync",
    `Full org sync complete: ${teamCount} teams, ${orgMemberCount} members`,
    {
      items_fetched: orgMemberCount,
      duration_ms: Date.now() - startTime,
    },
  );
}
