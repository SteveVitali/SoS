# Discord Bot Setup

## Create the Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **"New Application"**.
2. Name it (e.g., "Son of Steve") and click **Create**.
3. In the left sidebar, click **"Bot"**.
4. Click **"Reset Token"** → copy the token. This is your `DISCORD_BOT_TOKEN`.
5. Copy the **Application ID** from the **"General Information"** page → this is your `DISCORD_BOT_USER_ID`.

## Enable Privileged Intents

On the **Bot** page, scroll to **"Privileged Gateway Intents"** and enable all three:

- ✅ **Presence Intent**
- ✅ **Server Members Intent**
- ✅ **Message Content Intent** ← **critical** — without this the bot cannot read message text

Click **"Save Changes"**.

## Invite the Bot to Your Server

1. Go to **"OAuth2" → "URL Generator"** in the left sidebar.
2. Under **Scopes**, select `bot`.
3. Under **Bot Permissions**, select:
   - `Send Messages`
   - `Read Message History`
   - `Attach Files`
   - `Use External Emojis` (optional)
4. Copy the generated URL, open it in your browser, and select the Discord server to add the bot to.

## Configure Environment

Add the following to your `.env` file:

```bash
# Discord
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_BOT_USER_ID=your-application-id-here

# Discord job ownership (must match a worker's SOS_REQUESTED_BY_SLACK_USER for workers to claim Discord-created jobs)
SOS_DISCORD_JOB_OWNER=your-discord-user-id

# Always @-mention this Discord user in bot messages (optional, for personal notifications)
# SOS_DISCORD_NOTIFY_USER=your-discord-user-id
```

### Finding Your Discord User ID

1. In Discord, go to **User Settings → Advanced → Developer Mode → ON**
2. Right-click your username anywhere → **"Copy User ID"**
3. Use this for `SOS_DISCORD_JOB_OWNER` and optionally `SOS_DISCORD_NOTIFY_USER`.

## How It Works

The Discord integration mirrors the Slack integration exactly:

1. The bot connects via the Discord Gateway (WebSocket) using `discord.js`.
2. When someone `@mentions` the bot, the message is routed through the same LLM pipeline as Slack (`routeMessage()` → `executeCommand()`).
3. All the same actions are available: create jobs, check status, cancel, retry, chat, GitHub queries, KB search, image generation, etc.
4. Job lifecycle notifications (queued, claimed, PR created, CI status, done/failed) are posted to the Discord channel/thread where the job was created.
5. Thread context and file attachments work the same way — the bot fetches thread history and downloads attachments for context.

### Slack vs Discord Differences

| Feature | Slack | Discord |
|---------|-------|---------|
| Connection | Socket Mode (`@slack/bolt`) | Gateway (`discord.js`) |
| Message limit | 4,000 chars | 2,000 chars (auto-split) |
| Markdown | Slack mrkdwn (converted) | Standard markdown (native) |
| Threads | Slack threads (`thread_ts`) | Discord threads (`threadId`) |
| User mentions | `<@U123>` | `<@123456>` |
| File access | Requires `files:read` OAuth scope | Public attachment URLs |

## LLM-Powered Message Routing

Discord uses the **same LLM routing** as Slack. If you've already configured an LLM provider (see [SLACK_SETUP.md](SLACK_SETUP.md#llm-powered-message-routing)), it works for Discord automatically — no additional LLM configuration needed.

Without an LLM key, message routing is disabled and @-mentions receive an error reply instead of being acted on (same behavior as Slack).

## Thread Context & File Attachments

When someone @-mentions the bot in a Discord thread, the bot automatically:

1. **Fetches thread history** — reads up to `SOS_MAX_THREAD_MESSAGES` (default 20) prior messages for context
2. **Downloads file attachments** — images, logs, configs, etc. attached to thread messages, newest-first up to `SOS_MAX_ATTACHMENT_SIZE_MB` (default 10MB)
3. **Sends images to the routing LLM** — vision-capable models can "see" screenshots
4. **Passes all files to the worker** — stored in the job document for Claude Code to inspect

These limits are shared with Slack (same env vars):

```bash
SOS_MAX_THREAD_MESSAGES=20        # max thread messages to fetch for context
SOS_MAX_ATTACHMENT_SIZE_MB=10     # max total file size per job
```

## Running Both Slack and Discord

Slack and Discord can run simultaneously. The server creates a `CompositePoster` that fans out job notifications to all enabled platforms. A job created from Discord gets Discord thread updates; a job created from Slack gets Slack thread updates. Both integrations are fully optional — enable either, both, or neither.
