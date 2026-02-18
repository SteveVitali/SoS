import { createLogger } from "../../shared/logger.js";
import type { RepoEntry, RepoRegistry } from "./repoRegistry.js";

const log = createLogger("worker:repoResolver");

export interface ResolveResult {
  repo: RepoEntry;
  method: "hint" | "keyword";
  score: number;
  warning?: string;
}

export function resolveRepo(
  registry: RepoRegistry,
  taskText: string,
  repoHint?: string,
): ResolveResult | null {
  // If hint matches a repoId directly
  if (repoHint) {
    const entry = registry.repos.get(repoHint);
    if (entry) {
      log.info("Repo resolved by hint", { repoId: repoHint });
      return { repo: entry, method: "hint", score: 1 };
    }
    log.warn("repo_hint did not match any registry entry", { hint: repoHint });
  }

  // Keyword matching
  const scores: Array<{ entry: RepoEntry; score: number }> = [];
  const textLower = taskText.toLowerCase();

  for (const [_id, entry] of registry.repos) {
    const keywords = entry.detect?.keywords || [];
    let score = 0;
    for (const kw of keywords) {
      if (textLower.includes(kw.toLowerCase())) {
        score++;
      }
    }
    if (score > 0) {
      scores.push({ entry, score });
    }
  }

  if (scores.length === 0) {
    log.warn("No repo matched by keywords", { task_text_len: taskText.length });
    return null;
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  let warning: string | undefined;
  if (scores.length > 1 && scores[0].score === scores[1].score) {
    warning = `Ambiguous repo match: ${scores.map((s) => s.entry.id).join(", ")} (picked ${best.entry.id})`;
    log.warn(warning);
  }

  log.info("Repo resolved by keywords", { repoId: best.entry.id, score: best.score });
  return { repo: best.entry, method: "keyword", score: best.score, warning };
}
