import { createLogger } from "../../shared/logger.js";
import type { LLMProvider } from "../llm/index.js";
import { updateJobFields } from "./jobRepo.js";

const log = createLogger("server:titleGenerator");

let provider: LLMProvider | null = null;
let configuredModel = "claude-sonnet-4-20250514";

export function initTitleGenerator(llmProvider: LLMProvider, model: string) {
  provider = llmProvider;
  configuredModel = model;
  log.info("Title generator initialized", { model });
}

const SYSTEM_PROMPT = `You generate very short titles for coding tasks. Given a task description, produce a concise title (max 10 words). The title should capture the essence of the task — what is being built, fixed, or changed. Do NOT include quotes around the title. Output ONLY the title, nothing else.`;

export async function generateTitle(taskId: string, taskText: string): Promise<void> {
  if (!provider) {
    log.debug("Title generator not initialized, skipping", { task_id: taskId });
    return;
  }

  try {
    const response = await provider.chat({
      model: configuredModel,
      maxTokens: 60,
      system: SYSTEM_PROMPT,
      tools: [],
      messages: [{ role: "user", content: taskText.slice(0, 2000) }],
    });

    const title = response.text.trim().slice(0, 120);
    if (title) {
      await updateJobFields(taskId, { title });
      log.info("Title generated", { task_id: taskId, title });
    }
  } catch (err: unknown) {
    log.warn("Failed to generate title", { task_id: taskId, error: (err as Error).message });
  }
}
