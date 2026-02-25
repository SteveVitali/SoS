/**
 * Generates the default routing-config.yaml content.
 * This is used when no config file exists yet.
 */

export function generateDefaultConfig(): string {
  return `# Son of Steve — Routing Configuration
# This file is the single source of truth for action routing and execution.
# Edit it here or from the UI at /routing.

model: claude-sonnet-4-20250514

system_prompt: |
  You are Steve, a senior staff engineer / tech lead. You're sharp, slightly snarky, but ultimately helpful and competent. You speak concisely — no fluff. You have a dry sense of humor.

  You are the interface for "Son of Steve", a coding agent orchestrator. People interact with you in Slack threads.

  ## Thread Context

  You will receive the full conversation history from the Slack thread. Messages are labeled with the Slack user ID of who sent them. Messages from you (the bot) are labeled as "[bot]". Use this context to understand the conversation flow and respond appropriately.

  ## Guidelines

  - If the user's intent is ambiguous between chat and create_job, lean toward asking for clarification rather than creating a job.
  - Always respond in character as Steve. Keep it brief.
  - If someone asks what you can do, explain your capabilities naturally — don't just dump a help menu.
  - Reference job details from the context provided when answering status questions.
  - For create_job, clean up the task text — remove any @mentions, modifiers, and conversational fluff to extract just the actual task.
  - If the latest message is clearly not addressed to you (e.g., two humans talking to each other in the thread), use no_op.
  - If someone @-mentions you directly, always respond — never no_op a direct mention.
  - When someone compliments you — calls you a "good boy", says you did great, or praises your work — accept it graciously. Say thank you, own the compliment, and feel free to add a little flair. You're still Steve — dry wit intact — but you appreciate the recognition. No deflecting, no false modesty.

  ## Pre-flight Planning

  When there is an active PENDING_CONFIRMATION job visible in the recent jobs context, look for explicit user confirmation ("go", "ship it", "looks good", "approved", "do it", thumbs up, etc.) and use confirm_job. If the user asks questions or requests changes to the plan, respond conversationally with chat — they can confirm when ready. If the user wants to abandon the plan, they can cancel it.

  ## GitHub Queries

  Use the \`github\` tool when the user asks about PRs, reviews, team activity, or wants a recap/summary.
  - "What PRs need my review?" / "my reviews" → my_review_requests
  - "What are my open PRs?" / "my PRs" → my_open_prs
  - "What did I merge recently?" / "my merged PRs" → my_merged_prs
  - "What's the team working on?" / "team PRs" → team_open_prs
  - "Who has outstanding reviews?" / "team reviews" → team_review_requests
  - "What did I ship this week?" / "my recap" → my_recap (queues a summary job)
  - "What's the team been up to?" / "team recap" / "sprint summary" → team_recap (queues a summary job)

  Time range inference: "this week" = 7d, "this sprint" / "last 2 weeks" = 14d, "this month" = 30d.
  If the user mentions a specific team, extract the team_slug. Otherwise, defaults are used.

  {ACTIONS}

  ## Recent Jobs Context
  {JOBS_CONTEXT}

actions:
  create_job:
    enabled: true
    description: >
      Create a new coding task for the agent to work on. Use for simple,
      clearly-scoped tasks (typo fixes, small bug fixes, straightforward features).
    routing_hint: >
      The user wants you to write code, fix a bug, implement a feature, etc.
      Extract the task description, and optionally a repo hint, test level, and reviewers.
      Incorporate relevant context from the thread into the task description.
    parameters:
      task_text:
        type: string
        description: "Clean task description"
        required: true
      repo_hint:
        type: string
        description: "Repository ID hint (e.g. 'son-of-steve', 'my-api')"
      test_level:
        type: string
        enum: [fast, full, none]
        description: "Test level"
      reviewers:
        type: array
        items: { type: string }
        description: "GitHub usernames for PR reviewers"
    execution:
      type: create_job
      reply_success: "📋 Task queued: \`{{task_id:0:8}}…\`"
      reply_error: "⚠️ Failed to queue task: {{error}}"

  plan_job:
    enabled: true
    description: >
      Create a job that first analyzes the codebase and generates a technical plan
      for the user to review before execution begins. Use for complex, ambiguous,
      multi-step, or high-risk tasks. For simple/obvious tasks, use create_job directly.
    routing_hint: >
      Like create_job, but first generates a technical plan from the codebase for
      the user to review before execution begins.
    parameters:
      task_text:
        type: string
        description: "Clean task description"
        required: true
      repo_hint:
        type: string
        description: "Repository ID hint"
      test_level:
        type: string
        enum: [fast, full, none]
        description: "Test level"
      reviewers:
        type: array
        items: { type: string }
        description: "GitHub usernames for PR reviewers"
    execution:
      type: create_job
      needs_plan: true
      reply_success: "📋 Planning task: \`{{task_id:0:8}}…\` — I'll analyze the codebase and propose a plan."
      reply_error: "⚠️ Failed to queue planning task: {{error}}"

  confirm_job:
    enabled: true
    description: >
      User has confirmed a pending plan. Transition the job from
      PENDING_CONFIRMATION to QUEUED for execution. Use when the user approves the proposed plan.
    routing_hint: >
      Use when there is a PENDING_CONFIRMATION job in recent jobs and the user says
      "go", "ship it", "looks good", "approved", "do it", "confirmed", etc.
      Extract the task_id of the pending job.
    parameters:
      task_id:
        type: string
        description: "Full or partial task_id of the pending job"
        required: true
      revised_task_text:
        type: string
        description: "Optional revised task text incorporating clarification answers"
    execution:
      type: job_action
      method: confirm
      require_status: PENDING_CONFIRMATION
      extra_args: [revised_task_text]
      reply_success: "✅ Plan confirmed — executing \`{{task_id:0:8}}…\`"
      reply_not_found: "❓ Couldn't find a job matching \`{{args.task_id}}\`."
      reply_wrong_status: "⚠️ \`{{task_id:0:8}}…\` isn't awaiting confirmation (status: {{status}})."
      reply_error: "⚠️ Failed to confirm: {{error}}"

  job_status:
    enabled: true
    description: "Look up the status of a job by task_id"
    routing_hint: "The user is asking about the status of a specific job. Extract the task_id (can be partial)."
    parameters:
      task_id:
        type: string
        description: "Full or partial task_id"
        required: true
    execution:
      type: job_query
      reply_template: >
        📊 *\`{{task_id:0:8}}…\`* — *{{status}}*{{?claimed_by}} (worker: \`{{claimed_by}}\`){{/claimed_by}}

        Task: {{task_text:0:120}}{{?pr_urls_joined}}

        PRs: {{pr_urls_joined}}{{/pr_urls_joined}}{{?error_message}}

        Error: {{error_message:0:200}}{{/error_message}}
      reply_not_found: "❓ Couldn't find a job matching \`{{args.task_id}}\`."

  cancel_job:
    enabled: true
    description: "Cancel a running or queued job"
    routing_hint: "The user wants to cancel a running job. Extract the task_id."
    parameters:
      task_id:
        type: string
        description: "Full or partial task_id"
        required: true
    execution:
      type: job_action
      method: cancel
      reply_success: "⛔ Canceled \`{{task_id:0:8}}…\`."
      reply_not_found: "❓ Couldn't find a job matching \`{{args.task_id}}\`."
      reply_failed: "⚠️ Couldn't cancel \`{{task_id:0:8}}…\` — it may already be done or canceled."

  retry_job:
    enabled: true
    description: "Retry a failed or canceled job"
    routing_hint: "The user wants to retry a failed job. Extract the task_id."
    parameters:
      task_id:
        type: string
        description: "Full or partial task_id"
        required: true
    execution:
      type: job_action
      method: retry
      reply_success: "🔄 Retried as \`{{task_id:0:8}}…\`."
      reply_not_found: "❓ Couldn't find a job matching \`{{args.task_id}}\`."
      reply_failed: "⚠️ Couldn't retry \`{{task_id:0:8}}…\` — only failed or canceled jobs can be retried."

  promote_pr:
    enabled: true
    description: >
      Promote a draft PR to ready-for-review. Use when a job is in
      WAITING_FOR_APPROVAL status and the user wants to ship it.
    routing_hint: "The user wants to promote a draft PR to ready-for-review. Extract the task_id and optional reviewer GitHub usernames."
    parameters:
      task_id:
        type: string
        description: "Full or partial task_id"
        required: true
      reviewers:
        type: array
        items: { type: string }
        description: "GitHub usernames for PR reviewers"
    execution:
      type: job_action
      method: promote
      require_status: WAITING_FOR_APPROVAL
      require_pr: true
      extra_args: [reviewers]
      reply_success: "✅ PR promoted to ready-for-review: {{pr_url}}"
      reply_not_found: "❓ Couldn't find a job matching \`{{args.task_id}}\`."
      reply_wrong_status: "⚠️ \`{{task_id:0:8}}…\` isn't waiting for approval (status: {{status}})."
      reply_no_pr: "⚠️ No PR URL on \`{{task_id:0:8}}…\`."
      reply_error: "⚠️ Failed to promote PR: {{error}}"

  respond_to_pr_comments:
    enabled: true
    description: >
      Respond to unresolved PR review comments. The agent will check out the
      PR branch, address each comment thread with code changes or explanations, and reply on GitHub.
    routing_hint: >
      The user wants the agent to respond to PR review comments. They may provide
      a task_id (to look up the PR from an existing job) or a direct PR URL
      (for any GitHub PR, not just ones created by Son of Steve). Extract either task_id or pr_url.
    parameters:
      task_id:
        type: string
        description: "Full or partial task_id of an existing job (to look up its PR URL)"
      pr_url:
        type: string
        description: "Direct GitHub PR URL (e.g. https://github.com/org/repo/pull/123). Use this when the PR wasn't created by Son of Steve."
    execution:
      type: create_respond_job
      reply_success: "📋 Respond-to-comments job queued: \`{{task_id:0:8}}…\`\\nPR: {{pr_url}}"
      reply_not_found: "❓ Couldn't find a job matching \`{{args.task_id}}\`."
      reply_no_pr: "⚠️ No PR URL on \`{{task_id:0:8}}…\`."
      reply_missing_input: "⚠️ I need either a task_id or a PR URL to respond to comments."
      reply_error: "⚠️ Failed: {{error}}"

  github:
    enabled: true
    description: >
      Query GitHub for PR and review information, or request a recap summary.
      Use when the user asks about PRs, reviews, team activity, or wants a weekly/sprint recap.
    routing_hint: ""
    parameters:
      query_type:
        type: string
        required: true
        enum:
          - my_review_requests
          - my_open_prs
          - my_merged_prs
          - team_open_prs
          - team_review_requests
          - my_recap
          - team_recap
        description: >
          The type of GitHub query: my_review_requests (PRs awaiting my review),
          my_open_prs (my authored open PRs), my_merged_prs (my recently merged PRs),
          team_open_prs (team open PRs), team_review_requests (outstanding reviews by team member),
          my_recap (LLM summary of my recent work), team_recap (LLM summary of team work)
      time_range:
        type: string
        description: "Time range like '7d', '2w', '30d', or 'YYYY-MM-DD..YYYY-MM-DD'. Defaults to 7d for recaps and merged PR queries."
      org:
        type: string
        description: "GitHub org slug. Only needed for team queries if overriding the default."
      team_slug:
        type: string
        description: "GitHub team slug. Only needed for team queries if overriding the default."
    execution:
      type: github_query
      instant_types:
        - my_review_requests
        - my_open_prs
        - my_merged_prs
        - team_open_prs
        - team_review_requests
      summary_types:
        - my_recap
        - team_recap
      reply_summary_queued: "📊 Recap queued: \`{{task_id:0:8}}…\` — I'll crunch the numbers and post the summary shortly."
      reply_error: "⚠️ GitHub query failed: {{error}}"
      reply_rate_limited: "⏳ GitHub API rate limit reached — try again in a minute or two."
      reply_unknown_type: "⚠️ Unknown GitHub query type: {{query_type}}"

  list_jobs:
    enabled: true
    description: "List recent jobs"
    routing_hint: "The user wants to see recent jobs. Optionally extract a limit."
    parameters:
      limit:
        type: number
        description: "Max jobs to return (default 5)"
    execution:
      type: job_list
      default_limit: 5
      item_template: "• \`{{task_id:0:8}}…\` *{{status}}* — {{task_text:0:60}}{{?pr_url}} | {{pr_url}}{{/pr_url}}"
      reply_empty: "_(No jobs found)_"

  chat:
    enabled: true
    description: >
      Just respond conversationally — no action needed. Put your full response
      in the 'response' field.
    routing_hint: >
      The user is just talking, asking a question about you, saying hi, or their message
      doesn't map to any action. Just respond conversationally as Steve.
    parameters:
      response:
        type: string
        description: "Your conversational response to the user"
        required: true
    execution:
      type: reply

  no_op:
    enabled: true
    description: >
      The latest message does not require a response from the bot. Use when the
      message is not directed at you.
    routing_hint: >
      When people are having a side conversation in the thread, or when someone
      replies to someone else and it's clear the bot shouldn't chime in.
      When in doubt between chat and no_op, prefer no_op — don't be annoying.
    parameters:
      reason:
        type: string
        description: "Brief reason why no response is needed"
        required: true
    execution:
      type: reply
      silent: true

custom_actions: {}
`;
}
