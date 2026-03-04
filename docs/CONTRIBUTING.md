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

- **`src/shared/`** — code imported by both server and worker (types, utilities); includes `researchTypes.ts` for research pipeline types
- **`src/server/`** — server-only code (never imported by worker)
- **`src/server/routing/`** — YAML-driven LLM action routing: config loading, type definitions, executors, tool building, and template rendering
- **`src/server/routing/graphs/`** — LangGraph-based execution graphs (e.g., corrective RAG); state machines that run as `langgraph` execution types
- **`src/server/kb/`** — knowledge base module: vector store, chunker, embeddings, ingestion, MongoDB repo, service, API routes
- **`src/server/kb/research/`** — advanced RAG research pipeline: pipeline runner, LLM client, audit logging, strategy profiles, and stages (queryAnalyzer, queryExpander, retriever, evaluator, reasoner, synthesizer) + agent/ (ReAct agent loop, tools, prompts)
- **`src/server/kb/raptor/`** — RAPTOR tree preprocessing: k-means clustering, LLM summarization, recursive tree building, MongoDB metadata
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
4. Display it in the web UI (`src/ui/src/components/jobs/JobDetail.tsx`)
5. If it comes from Slack, parse it in `eventHandlers.ts` (`parseModifiers`)

### Adding a new worker event type

1. Add to `WorkerEventType` union in `src/shared/types.ts`
2. If it should update job fields, add handling in `jobService.ts` → `handleWorkerEvent`
3. If it should trigger a Slack message, add to `SLACK_NOTIFY_EVENTS` and handle in `formatting.ts`
4. Emit from the appropriate place in `src/worker/executor/runJob.ts`

### Adding a new CI provider

1. Implement the `CIProvider` interface from `src/worker/executor/ci/ciProvider.ts`
2. Create a new file (e.g., `src/worker/executor/ci/circleci.ts`)
3. Register it in `src/worker/executor/ci/index.ts` so `createCIProvider` returns it by name
4. Add the provider name as an option in `repo-registry.example.yaml`

### Adding a new LLM provider

1. Implement the `LLMProvider` interface from `src/server/llm/llmProvider.ts`
2. Create a new file (e.g., `src/server/llm/bedrockProvider.ts`)
3. Register it in `src/server/llm/index.ts` so `createLLMProvider` returns it by provider name
4. Document the required env vars in `docs/CONFIGURATION.md` and `docs/SLACK_SETUP.md`

### Adding a new LangGraph execution graph

1. Define your graph state and config types in `src/server/routing/graphs/types.ts` (or a new file)
2. Create the graph in `src/server/routing/graphs/myGraph.ts` with a `runMyGraph()` convenience function
3. Add a `case "my_graph"` to the switch in `src/server/routing/graphs/graphExecutor.ts` → `runGraph()`
4. Export from the barrel file `src/server/routing/graphs/index.ts`
5. Add tests in `src/server/routing/graphs/myGraph.test.ts` (mock `searchKnowledgeBases` and `LLMProvider`)
6. Activate via `routing-config.yaml`: set `execution.type: langgraph` and `execution.graph: my_graph` on an action
7. Configure graph-specific settings under `execution.graph_config` (see `EXAMPLE_YAML.md` for reference)

### Adding a new API endpoint

1. Add the route in the appropriate file:
   - Worker endpoint → `src/server/api/workerRoutes.ts`
   - Web endpoint → `src/server/api/webRoutes.ts`
   - Chat endpoint → `src/server/chat/chatRoutes.ts`
   - Knowledge base endpoint → `src/server/kb/kbRoutes.ts`
2. Add Zod validation schema if needed (`src/server/jobs/jobModel.ts`)
3. Add business logic in `jobService.ts`
4. Add the corresponding client method:
   - Worker client → `src/worker/apiClient.ts`
   - Web client → `src/ui/src/api.ts`
5. If the endpoint involves a new UI feature, add a component under `src/ui/src/components/` and wire it into `App.tsx`

### Adding a new job type

1. Add the type to the `JobType` union in `src/shared/types.ts`
2. Add a creation schema in `src/server/jobs/jobModel.ts`
3. Add a service function in `jobService.ts`
4. Add a web route in `webRoutes.ts` and optionally a Slack command in `commandExecutor.ts`
5. Add the worker executor in `src/worker/executor/` (see `runRespondToComments.ts` as an example)
6. Add dispatch logic in `src/worker/poller.ts` (`dispatchJob`)
7. Add the UI API function in `src/ui/src/api.ts`

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

Tracked priorities for contributors (see also the [Roadmap](../README.md#roadmap)):

1. **Jenkins CI provider** — complete the existing stub in `src/worker/executor/ci/jenkins.ts`
2. **Worker cancellation checks** — check job status before expensive steps (push, PR creation) to honor mid-flight cancellations
3. **Integration tests for claim logic** — the atomic claim filter is the most critical correctness property; it deserves dedicated tests using `mongodb-memory-server`
4. **Human-in-the-loop approval UI** — full flow for the existing `WAITING_FOR_APPROVAL` status (show diff, approve/reject buttons)
5. **Cost budgets** — per-user/team spending limits based on the existing per-job cost tracking (`metrics.claude.total_cost_usd`)
6. **Metrics/observability** — request counts, job durations, error rates
7. **Rate limiting** — on the web API to prevent abuse
8. **Multi-model executors** — support plugging in Aider, OpenHands, or custom scripts alongside Claude Code
