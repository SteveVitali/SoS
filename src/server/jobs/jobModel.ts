import { z } from "zod";
import { TestLevel } from "../../shared/types.js";

export const CreateJobFromSlackSchema = z.object({
  event_id: z.string(),
  requested_by: z.string(),
  slack_requester: z.string().optional(),
  task_text: z.string(),
  channel_id: z.string(),
  thread_ts: z.string(),
  message_ts: z.string().optional(),
  repo_hint: z.string().optional(),
  test_level: TestLevel.optional(),
  ci_fix_enabled: z.boolean().optional(),
  reviewers: z.array(z.string()).optional(),
  attachments: z
    .array(
      z.object({
        file_id: z.string(),
        filename: z.string(),
        mimetype: z.string(),
        size_bytes: z.number(),
        base64: z.string(),
      }),
    )
    .optional(),
  needs_plan: z.boolean().optional(),
  custom_instructions: z.string().optional(),
});
export type CreateJobFromSlack = z.infer<typeof CreateJobFromSlackSchema>;

export const CreateJobFromDiscordSchema = z.object({
  event_id: z.string(),
  requested_by: z.string(),
  discord_requester: z.string().optional(),
  task_text: z.string(),
  channel_id: z.string(),
  thread_id: z.string().optional(),
  message_id: z.string().optional(),
  guild_id: z.string().optional(),
  repo_hint: z.string().optional(),
  test_level: TestLevel.optional(),
  ci_fix_enabled: z.boolean().optional(),
  reviewers: z.array(z.string()).optional(),
  attachments: z
    .array(
      z.object({
        file_id: z.string(),
        filename: z.string(),
        mimetype: z.string(),
        size_bytes: z.number(),
        base64: z.string(),
      }),
    )
    .optional(),
  needs_plan: z.boolean().optional(),
  custom_instructions: z.string().optional(),
});
export type CreateJobFromDiscord = z.infer<typeof CreateJobFromDiscordSchema>;

export const CreateJobFromWebSchema = z.object({
  requested_by: z.string().min(1, "requested_by is required"),
  task_text: z.string().min(1, "task_text is required"),
  repo_hint: z.string().optional(),
  test_level: TestLevel.optional(),
  ci_fix_enabled: z.boolean().optional(),
  reviewers: z.array(z.string()).optional(),
  needs_plan: z.boolean().optional(),
  custom_instructions: z.string().optional(),
});
export type CreateJobFromWeb = z.infer<typeof CreateJobFromWebSchema>;

export const CreateRespondToCommentsFromWebSchema = z.object({
  requested_by: z.string().min(1, "requested_by is required"),
  pr_url: z.string().url("pr_url must be a valid URL"),
  parent_task_id: z.string().optional(),
});
export type CreateRespondToCommentsFromWeb = z.infer<typeof CreateRespondToCommentsFromWebSchema>;

export const CreateSelfReviewPrSchema = z.object({
  requested_by: z.string().min(1, "requested_by is required"),
  pr_url: z.string().url("pr_url must be a valid URL"),
});
export type CreateSelfReviewPr = z.infer<typeof CreateSelfReviewPrSchema>;

export const CreateAddReviewCommentsSchema = z.object({
  requested_by: z.string().min(1, "requested_by is required"),
  pr_url: z.string().url("pr_url must be a valid URL"),
});
export type CreateAddReviewComments = z.infer<typeof CreateAddReviewCommentsSchema>;

export const ClaimJobSchema = z.object({
  requested_by: z.string(),
  node_id: z.string(),
  lease_seconds: z.number().int().positive(),
});

export const HeartbeatSchema = z.object({
  node_id: z.string(),
  extend_seconds: z.number().int().positive(),
});

export const WorkerEventSchema = z.object({
  node_id: z.string(),
  type: z.string(),
  payload: z.any().optional(),
});

const MetricsSchema = z
  .object({
    durations: z.record(z.number()).optional(),
    claude: z
      .object({
        sessions: z.array(z.any()).optional(),
        total_input_tokens: z.number().optional(),
        total_output_tokens: z.number().optional(),
        total_cost_usd: z.number().optional(),
        cost_source: z.enum(["provider", "computed"]).optional(),
      })
      .optional(),
  })
  .optional();

export const CompleteJobSchema = z.object({
  node_id: z.string(),
  result_summary: z.string(),
  pr_urls: z.array(z.string()).optional(),
  ci: z
    .object({
      provider: z.string().optional(),
      runs: z
        .array(
          z.object({
            url: z.string(),
            status: z.string(),
            conclusion: z.string().optional(),
            updated_at: z.coerce.date().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  metrics: MetricsSchema,
});

export const SubmitPlanSchema = z.object({
  node_id: z.string(),
  plan_summary: z.string().min(1, "plan_summary is required"),
  metrics: MetricsSchema,
});

export const FailJobSchema = z.object({
  node_id: z.string(),
  error: z.object({
    code: z.string().optional(),
    message: z.string(),
    details: z.any().optional(),
  }),
  pr_urls: z.array(z.string()).optional(),
  ci: z
    .object({
      provider: z.string().optional(),
      runs: z
        .array(
          z.object({
            url: z.string(),
            status: z.string(),
            conclusion: z.string().optional(),
            updated_at: z.coerce.date().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  metrics: MetricsSchema,
});
