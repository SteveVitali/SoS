# Contributing to Son of Steve

Guide for human and AI agent contributors.

## Development Setup

```bash
# Install dependencies
npm install

# Start MongoDB locally via Docker Compose
docker compose up -d

# Copy and fill environment
cp .env.example .env

# Run in dev mode (server + worker + UI hot reload)
npm run dev

# Or run components individually:
npm run server       # Express + Slack Socket Mode
npm run worker       # Worker pool
npm run dev:ui       # Vite dev server on :5173 with API proxy to :3000
```

### Code Quality Commands

```bash
npm run check        # Biome lint + format check (CI uses this)
npm run check:fix    # Auto-fix lint + format issues
npm run typecheck    # TypeScript type checking
npm test             # Run Vitest unit tests
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
```

Pre-commit hooks (via Husky + lint-staged) automatically run `biome check --write` on staged files.

## Project Conventions

### TypeScript

- **ESM only** — all files use `import`/`export`, no `require()`
- **`.js` extensions in imports** — required for ESM resolution (e.g., `import { foo } from "./bar.js"`)
- **Zod for validation** — API input schemas in `src/server/jobs/jobModel.ts`
- **Strict mode** — `tsconfig.json` has `"strict": true`
- **No default exports** — use named exports everywhere

### Code Style

- Structured JSON logging via `createLogger(component)` — never use raw `console.log`
- Logger automatically redacts common token patterns (xoxb-, xapp-, ghp_, Bearer)
- Express route handlers: extract params via `pstr()` / `qstr()` helpers for Express v5 type safety
- Prefer early returns over deep nesting
- All Mongo operations go through `jobRepo.ts` — no direct collection access from services/routes

### File Organization

- **`src/shared/`** — code imported by both server and worker (types, utilities)
- **`src/server/`** — server-only code (never imported by worker)
- **`src/worker/`** — worker-only code (never imported by server)
- **`src/ui/`** — React SPA with its own `tsconfig.json` (excluded from server compilation)

### Naming

- **Files**: `camelCase.ts` (e.g., `jobRepo.ts`, `slackClient.ts`)
- **Types/Interfaces**: `PascalCase` (e.g., `JobDoc`, `WorkerConfig`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `TERMINAL_STATUSES`, `SLACK_NOTIFY_EVENTS`)
- **Functions**: `camelCase` (e.g., `createJobFromSlack`, `atomicClaim`)
- **Env vars**: `UPPER_SNAKE_CASE` with `SOS_` prefix for app-specific vars

## Adding a New Feature

### Adding a new job field

1. Add to `JobDoc` interface in `src/shared/types.ts`
2. Add Zod validation if it's an API input (`src/server/jobs/jobModel.ts`)
3. Set it during creation in `jobService.ts` (`createJobFromSlack` / `createJobFromWeb`)
4. Display it in the web UI (`src/ui/src/App.tsx` — job detail section)
5. If it comes from Slack, parse it in `eventHandlers.ts` (`parseModifiers`)

### Adding a new worker event type

1. Add to `WorkerEventType` union in `src/shared/types.ts`
2. If it should update job fields, add handling in `jobService.ts` → `handleWorkerEvent`
3. If it should trigger a Slack message, add to `SLACK_NOTIFY_EVENTS` and handle in `formatting.ts`
4. Emit from the appropriate place in `src/worker/executor/runJob.ts`

### Adding a new CI provider

1. Implement the `CIProvider` interface from `src/worker/executor/ci/ciProvider.ts`
2. Create a new file (e.g., `src/worker/executor/ci/circleci.ts`)
3. Select it in `runJob.ts` based on `repo.ci.provider` from the registry
4. Add the provider name as an option in `repo-registry.example.yaml`

### Adding a new API endpoint

1. Add the route in the appropriate file:
   - Worker endpoint → `src/server/api/workerRoutes.ts`
   - Web endpoint → `src/server/api/webRoutes.ts`
2. Add Zod validation schema if needed (`src/server/jobs/jobModel.ts`)
3. Add business logic in `jobService.ts`
4. Add the corresponding client method:
   - Worker client → `src/worker/apiClient.ts`
   - Web client → `src/ui/src/api.ts`

## Testing

Unit tests use [Vitest](https://vitest.dev/) and live alongside source files as `*.test.ts`.

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode
npm run test:coverage # With V8 coverage
```

When adding tests:
- Place unit tests next to the source file as `*.test.ts`
- Use a test MongoDB instance (not the dev database)
- Mock external CLIs (claude, gh, git) in worker executor tests
- Test the atomic claim filter thoroughly — it's the most critical correctness property

### Manual Testing Checklist

- [ ] Create a job via web UI → appears in list
- [ ] Create a job via Slack mention → Slack thread gets "Queued" reply
- [ ] Worker claims and executes → status progresses through RUNNING → DONE/FAILED
- [ ] Kill a worker mid-job → lease expires → another worker reclaims
- [ ] Cancel a running job → status becomes CANCELED
- [ ] Retry a failed job → new job created with parent_task_id link
- [ ] Delete a non-running job → status becomes DELETED, hidden from list
- [ ] Duplicate Slack event → only one job created (idempotency)

## Commit Messages

Follow the pattern: `sos: <short description> (<scope>)`

Examples:
- `sos: add Jenkins CI provider (worker)`
- `sos: fix lease expiry filter off-by-one (server)`
- `sos: add dark mode toggle (ui)`

## Architecture Decisions

See [docs/ARCHITECTURE.md](./ARCHITECTURE.md) for detailed design rationale.

## Future Work

Tracked priorities for contributors:

1. **More automated tests** — integration tests for the API, jobRepo claim logic tests
2. **Cancellation check in worker** — workers should check job status before big steps (push, PR)
3. **Worktree cleanup** — automated cleanup of worktrees older than N days
4. **Jenkins CI provider** — currently a stub
5. **WAITING_FOR_APPROVAL status** — for ambiguous repo resolution, ask user to confirm
6. **Rate limiting** — on the web API to prevent abuse
7. **Metrics/observability** — request counts, job durations, error rates
