# Slack App Setup

## Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app.
2. Under **Socket Mode**, enable it. Generate an **App-Level Token** with `connections:write` scope → this is your `SLACK_APP_TOKEN` (`xapp-...`).
3. Under **Event Subscriptions**:
   - **Toggle "Enable Events" to ON** (this is off by default and easy to miss!)
   - Under "Subscribe to bot events", click "Add Bot User Event" and add `app_mention`
   - Save changes
   - **Security note**: Only subscribe to `app_mention`. Do **not** add `message.channels` or `message.groups` — the bot should only receive messages where it is explicitly @-mentioned. Thread context is fetched via API call when needed, not via event subscriptions.
4. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `app_mentions:read` — receive @-mentions
   - `chat:write` — post replies
   - `channels:history` — fetch thread messages in public channels (used when @-mentioned in a thread to read prior context)
   - `groups:history` — fetch thread messages in private channels
   - `files:read` — **(required for attachments)** download files attached to Slack messages (screenshots, logs, etc.)
   - `users:read` — **(recommended)** resolve Slack user IDs to display names in the UI
5. Install the app to your workspace. Copy the **Bot User OAuth Token** → `SLACK_BOT_TOKEN` (`xoxb-...`).
6. Find the bot's user ID (choose one method):
   - **Via API** (easiest): `curl -s -H "Authorization: Bearer xoxb-YOUR-TOKEN" https://slack.com/api/auth.test | jq .user_id`
   - **Via Slack UI**: Click on your bot in a channel → "View app details" → copy the member ID
   - This is your `SLACK_BOT_USER_ID` (`U...`).
7. **Invite the bot** to any channels where you want to @-mention it.

## Finding Your Slack User ID

Click your name in Slack → "Profile" → "⋯" → "Copy member ID". This is the `SOS_REQUESTED_BY_SLACK_USER` for the worker.

## LLM-Powered Message Routing (Optional)

By default, every @-mention of the bot creates a new coding job. If you configure an LLM provider, the bot instead routes messages through an LLM ("Steve" — a snarky staff engineer persona) that classifies intent before acting:

| Intent | Example | What happens |
|--------|---------|--------------|
| Coding task | "fix the login bug in auth module" | Creates a job |
| Status check | "what's the status of abc123?" | Looks up the job and replies |
| Cancel | "cancel that last job" | Cancels the job |
| Retry | "retry abc123" | Re-queues a failed job |
| List | "show me recent jobs" | Lists recent jobs |
| Chat | "hey what can you do?" | Responds conversationally |

Son of Steve supports **two LLM provider backends** for message routing. Choose whichever fits your setup:

### Option A: Anthropic API (default)

Best for open-source / individual users. Calls the Anthropic API directly.

```bash
# .env
SOS_LLM_PROVIDER=anthropic                     # set explicitly (default is openai_compatible)
SOS_LLM_MODEL=claude-opus-4.5               # optional, this is the default
SOS_LLM_API_KEY=sk-ant-...                      # or set ANTHROPIC_API_KEY
```

1. Get an API key from [console.anthropic.com](https://console.anthropic.com)
2. Add the key to your `.env` as shown above
3. Restart the server

### Option B: OpenAI-Compatible / LiteLLM

Best for teams that run a shared LLM proxy (e.g., [LiteLLM](https://docs.litellm.ai/)). Works with any service that exposes the OpenAI Chat Completions API with tool calling support.

```bash
# .env
SOS_LLM_PROVIDER=openai_compatible
SOS_LLM_MODEL=anthropic/claude-opus-4.5            # model string your proxy expects
SOS_LLM_BASE_URL=https://litellm.example.com       # your LiteLLM / OpenAI-compatible endpoint
SOS_LLM_API_KEY=your-bearer-token                   # sent as Authorization: Bearer <token>
```

The API key is sent via the standard `Authorization: Bearer <token>` header. Check with your proxy admin for the correct model string and endpoint URL.

### No LLM Key

Without any key, the bot still works — it just treats every @-mention as a job creation request (the original behavior).

## Thread Context & File Attachments

When someone @-mentions the bot in a Slack thread, the bot automatically:

1. **Fetches thread history** — reads up to `SOS_MAX_THREAD_MESSAGES` (default 20) prior messages for context
2. **Downloads file attachments** — images, logs, configs, etc. attached to thread messages, newest-first up to `SOS_MAX_ATTACHMENT_SIZE_MB` (default 10MB)
3. **Sends images to the routing LLM** — the LLM can "see" screenshots via vision, helping it understand UI bugs and generate better task descriptions
4. **Passes all files to the worker** — every attachment (regardless of type) is stored in the job document and written to `.sonofsteve/attachments/` in the worktree so Claude Code can inspect them

```bash
# .env (optional — these are the defaults)
SOS_MAX_THREAD_MESSAGES=20        # max thread messages to fetch for context
SOS_MAX_ATTACHMENT_SIZE_MB=10     # max total file size per job (newest files preferred)
```

> **Note:** File downloads require the `files:read` OAuth scope on your Slack bot. See step 4 above.
