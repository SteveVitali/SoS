# Memory System UI — Design Specification

> **Status**: Proposed. Pending confirmation before implementation.
> **Authors**: Steve Vitali + Cascade AI
> **Date**: March 2026
> **Depends on**: `MEMORY_SYSTEM_DESIGN.md` (Phases 1–7 fully implemented)

---

## 1. Overview

The memory system backend is fully operational — five async pipelines (episode recording, fact extraction, signal collection, reflection, memory evolution), hybrid search, and 12 HTTP API endpoints. This spec defines the complete frontend to make every aspect of the system visible, manageable, and debuggable.

### 1.1 Design Principles

- **Full transparency**: Every pipeline, every decision, every score should be inspectable. No black boxes.
- **Platform-aware context display**: Web chat shows expandable memory details; Slack/Discord responses include only aggregate metadata (e.g., "🧠 3 facts, 1 reflection used") — never memory content in external platforms.
- **Consistent with existing UI**: Same inline style system (`css.*` tokens from `theme.ts`), same patterns (sub-tab navigation like GitHub Hub, list→detail like Jobs/KB, stat cards, polling-based refresh).
- **Non-destructive by default**: Invalidation (soft-delete) is prominent; no physical deletion anywhere. Undo-friendly.
- **Zero-state friendly**: Every view handles the "nothing yet" case gracefully with helpful onboarding text.

### 1.2 Scope

| Area | What's Included |
|---|---|
| **Memory tab** (new) | Dashboard, memory browser, episode timeline, user profile, config editor |
| **Chat integration** (modify) | Memory context indicator on assistant messages, signal badges on user messages |
| **Backend changes** | One new field in chat message response (`memory_meta`), one small endpoint addition |
| **Nav** | New "Memory" tab in top nav bar |

---

## 2. Navigation & Routing

### 2.1 Top-Level Tab

Add `Memory` NavTab in `App.tsx` after "Research" and before "Routing":

```
Chats | Jobs | Git | Workers | Knowledge | Research | Memory | Routing | Models
```

Route: `/memory` — renders `MemoryPage` component.

### 2.2 Sub-Tab Navigation (hash-based, like GitHub Hub)

Inside `MemoryPage`, horizontal sub-tabs with hash routing:

```
Dashboard | Memories | Episodes | Profile | Config
```

- `/memory` or `/memory#dashboard` → Dashboard (default)
- `/memory#memories` → Memory browser
- `/memory#episodes` → Episode timeline
- `/memory#profile` → User profile viewer
- `/memory#config` → Runtime config editor

Pattern follows `GitHubPage.tsx` exactly: `useState<SubTab>`, hash-based tab switching, `hashchange` listener for back/forward navigation.

---

## 3. Dashboard View (`MemoryDashboard.tsx`)

The landing view. At-a-glance system health and activity.

### 3.1 System Status Banner

When memory is disabled (`config.enabled === false`), show a prominent yellow banner:
```
⚠ Memory system is disabled. Interactions are not being recorded.  [Enable →]
```
The "Enable" button calls `PUT /config` with `{ enabled: true }`.

### 3.2 Stat Cards Row

Four stat cards in a horizontal row (same visual pattern as GitHub contributions summary):

| Card | Data Source | Display |
|---|---|---|
| **Memories** | `GET /stats` → `active_memories` / `invalidated_memories` | "**42** active · 3 invalidated" |
| **By Type** | `GET /stats` → `memories_by_type` | "**28** facts · **12** reflections · **2** profiles" |
| **Episodes** | `GET /stats` → `total_episodes` | "**156** episodes recorded" |
| **Pipelines** | `GET /stats` → timestamps | "Last extraction: 2h ago · Last reflection: 18h ago" |

### 3.3 Recent Activity Feed

A compact reverse-chronological feed showing the last ~15 memory system events. Built by fetching recent episodes and memories, interleaving them by timestamp:

- `📝 Fact extracted` — "[content preview…]" · from slack · 2h ago
- `🔗 Memory linked` — "[content A]" ↔ "[content B]" · 2h ago
- `🪞 Reflection generated` — "[reflection preview…]" · from 5 episodes · 18h ago
- `👤 Profile updated` — synthesized from 42 memories · 18h ago
- `📊 Signals collected` — 3 episodes · gratitude ×1, correction ×1 · 25min ago
- `🎯 Episode recorded` — "How do I configure strict mode?" · web_chat · 30min ago

Each item is clickable — navigates to the memory detail or episode detail in the appropriate sub-tab.

**Implementation**: Fetch latest 15 memories (sorted by `created_at` desc) + latest 15 episodes (sorted by `timestamp` desc), merge and sort, render as a timeline. No new endpoint needed.

### 3.4 Quick Actions

Three buttons below the stat cards:

- **🔍 Search Memories** — opens the Memories sub-tab with search focused
- **▶ Run Reflection** — calls `POST /reflect`, shows spinner, then result toast: "Created 2 reflections from 3 clusters (12 episodes reviewed). Profile updated."
- **👤 View Profile** — navigates to Profile sub-tab

---

## 4. Memory Browser (`MemoryBrowser.tsx`)

The core inspection, search, and management interface.

### 4.1 Search & Filter Bar

Top bar with:

- **Search input** (full-width) — on submit, calls `POST /search` with hybrid search. Shows results with composite score breakdowns. Placeholder: "Search memories (hybrid: semantic + keyword)…"
- **Filter row** below the search:
  - **Type** dropdown: All | Facts | Reflections | Profiles
  - **Tag** dropdown (populated dynamically from distinct tags in results)
  - **Sort** dropdown: Newest | Oldest | Most Important | Most Accessed
  - **Toggle**: "Show invalidated" (default off)

When no search query is active, the view shows a paginated list via `GET /memories`. When a search query is active, it shows `POST /search` results with score breakdowns.

### 4.2 Memory List

Paginated list (same `Pagination` component as Jobs/Episodes). Each memory renders as a `MemoryCard`:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔵 FACT                                    importance: ████░░ 0.7 │
│                                             confidence: ███░░░ 0.6 │
│ The user prefers TypeScript strict mode and always enables       │
│ noUncheckedIndexedAccess in tsconfig.json.                       │
│                                                                  │
│ 🏷 typescript  strict_mode  code_style                           │
│                                                                  │
│ Learned Mar 15 · accessed 12× · from 2 episodes · 3 links       │
│ Source: slack                                          [✏️] [🗑️]  │
└─────────────────────────────────────────────────────────────────┘
```

- **Type badge**: colored — 🔵 `FACT`, 🟣 `REFLECTION`, 🟢 `PROFILE`
- **Importance bar**: visual 5-segment bar + numeric value (0.0–1.0)
- **Confidence bar**: same visual treatment
- **Tags**: rendered as clickable chips (clicking filters by that tag)
- **Metadata line**: learned date, access count, source episode count, link count
- **Source badge**: platform icon (Slack/Discord/Web/System)
- **Actions**: Edit ✏️ (inline), Invalidate 🗑️ (with confirmation)

For **reflections**, the card additionally shows: "From N interactions" (source_episodes count).

When search is active, each card additionally shows the **Score Breakdown** (see §4.4).

### 4.3 Memory Detail (Expandable Panel)

Clicking a memory card expands it in-place (accordion style) to show full detail:

**Content section**:
- Full `content` text
- `context` (LLM-generated contextual description, shown in muted text)
- `keywords` as chips
- `embedding_text` (collapsible, shown as monospace — useful for debugging search relevance)

**Temporal section**:
- `valid_from`: date
- `invalidated_at`: date (if applicable, shown in red)
- `invalidated_by`: link to the superseding memory (if set) — "Replaced by: [memory link]"

**Links section** ("Knowledge Graph"):
- List of linked memories as mini-cards (memory_id, content preview, link_reason)
- Each is clickable → navigates to that memory
- Shows bidirectional link count: "This memory links to 3 others; 2 others link back"

**Source Episodes section**:
- List of episode_ids as clickable links → navigates to Episodes sub-tab
- Each shows: timestamp, user_message preview, source badge

**Edit mode** (toggle via ✏️):
- Inline editable fields: `content` (textarea), `importance` (number input 0.0–1.0), `tags` (chip editor with add/remove)
- Save button calls `PUT /memories/:id` → re-embeds automatically
- Cancel button reverts

**Invalidate** (🗑️ button):
- Confirmation dialog: "This memory will be soft-deleted. It won't appear in search results or be injected into context. You can still view it by enabling 'Show invalidated'. Continue?"
- Calls `DELETE /memories/:id`

### 4.4 Score Breakdown (`ScoreBreakdown.tsx`)

When displaying search results, each memory card shows a visual breakdown of the composite score:

```
Score: 0.82
├─ Similarity  0.75  ███████░░░  (× 0.45 = 0.338)
├─ Recency     0.95  █████████░  (× 0.20 = 0.190)
├─ Importance  0.70  ███████░░░  (× 0.20 = 0.140)
└─ Access      0.60  ██████░░░░  (× 0.15 = 0.090)
                     ──────────
                     Composite:   0.758
```

Each factor shown as a labeled bar with the raw score, the weight, and the weighted contribution. Helps the user understand why certain memories rank higher.

---

## 5. Episodes Timeline (`EpisodesList.tsx`)

Interaction history — every recorded episode with its extraction results and signals.

### 5.1 Filter Bar

- **Source** dropdown: All | Slack | Discord | Web Chat
- **Action** dropdown: All | chat | create_job | kb_search | github | plan_job | …
- **Extraction Status** dropdown: All | Pending | Extracted | Skipped
- **Has Signals** toggle

### 5.2 Episode List

Paginated reverse-chronological list. Each episode renders as an `EpisodeCard`:

```
┌─────────────────────────────────────────────────────────────────┐
│ 💬 slack · chat                                    Mar 15, 2:34pm │
│                                                                   │
│ "How do I configure TypeScript strict mode in this repo?"         │
│                                                                   │
│ Response: "TypeScript strict mode can be enabled in tsconfig…"    │
│                                                                   │
│ ✅ Extracted (2 facts added, 1 updated)                           │
│ Signals: 😊 gratitude (+0.8)  📈 follow_up (+0.4)                │
│                                                                   │
│ Task: [abc123…]                                                   │
└─────────────────────────────────────────────────────────────────┘
```

- **Source + Action badges**: top-left
- **Timestamp**: top-right
- **User message**: prominent (truncated to ~200 chars, expandable)
- **Response summary**: muted text (truncated to ~200 chars, expandable)
- **Extraction status badge**:
  - ⏳ `pending` (gray) — "Awaiting extraction"
  - ✅ `extracted` (green) — "2 added, 1 updated, 0 deleted, 1 skipped"
  - ⏭ `skipped` (dim) — "Skipped by extraction filter"
- **Signal badges** (`SignalBadge.tsx`): each detected signal as a colored pill:
  - 😊 `gratitude` (green, +0.8)
  - ❌ `correction` (red, -0.6) — includes `details` on hover tooltip
  - 🔄 `rephrase` (orange, -0.4) — includes similarity score in tooltip
  - 📈 `follow_up_deeper` (blue, +0.4)
  - 🔀 `topic_change` (gray, 0.0)
  - 🔇 `no_response` (dim, -0.1)
  - ✅ `job_completed` (green, +1.0)
  - ❌ `job_failed` (red, -0.5)
  - ⬆ `continuation` (subtle, +0.2)
- **Task link**: if `task_id` is set, clickable link to `/jobs/:taskId`

### 5.3 Episode Detail (Expandable)

Clicking an episode expands to show:

- **Full user message** (untruncated)
- **Full response summary** (untruncated)
- **Action args summary** (monospace, collapsible)
- **Source ref details**: channel_id, thread_ts, conversation_id, etc.
- **Signals detail table**: each signal with `signal_type`, `strength`, `detected_at`, `details`
- **Extracted memories**: list of memory cards (fetched via `GET /episodes/:id` → `memories` array) — each clickable to navigate to that memory in the Memories sub-tab
- **Timestamps**: `timestamp`, `signal_collected_at` (if set)

---

## 6. User Profile View (`UserProfile.tsx`)

Dedicated view for the synthesized user profile — how Steve sees the user.

### 6.1 Profile Display

If a profile exists (`GET /profile` returns non-null):

```
┌─────────────────────────────────────────────────────────────────┐
│ 👤 User Profile                                                  │
│ Last updated: Mar 16, 2026 · Synthesized from 42 memories        │
│                                                                   │
│ [The profile content, rendered as formatted text — 200-400 words │
│  covering preferences, expertise, repos, patterns, corrections]  │
│                                                                   │
│ Keywords: user_profile, preferences, patterns                    │
│ Tags: user_profile                                               │
│                                                                   │
│ [✏️ Edit]  [🔄 Regenerate Profile]                                │
└─────────────────────────────────────────────────────────────────┘
```

- **Edit**: inline editing of the profile content (same pattern as memory edit)
- **Regenerate**: calls `POST /reflect`, which re-synthesizes the profile. Shows spinner + result.

### 6.2 Source Memories

Below the profile card, a collapsible section: "Memories that informed this profile"

Lists the top memories by importance (facts + reflections) that contributed to the profile synthesis. Each rendered as a mini `MemoryCard` (content preview, type, importance).

### 6.3 Zero State

If no profile exists:
```
No user profile has been synthesized yet.
This happens automatically after enough interactions (default: 10 episodes).
You can also trigger it manually.

[▶ Run Reflection Now]
```

---

## 7. Config Editor (`MemoryConfigEditor.tsx`)

Runtime configuration management. Pattern follows the Models page.

### 7.1 Layout

Grouped sections, each with labeled fields, current effective values, and env var source indicators.

### 7.2 Sections

**System**:
| Field | Type | Description |
|---|---|---|
| `enabled` | toggle | Master on/off for the entire memory system |

**Extraction (Pipeline B)**:
| Field | Type | Description |
|---|---|---|
| `extraction_model` | text (with model autocomplete) | LLM model for extraction |
| `extraction_min_turns` | number | Min conversation turns before extraction |
| `extraction_skip_actions` | chip editor | Actions to skip (comma-separated) |
| `extraction_max_facts_per_call` | number | Max facts per LLM call |

**Retrieval (Read Path)**:
| Field | Type | Description |
|---|---|---|
| `retrieval_max_memories` | number | Max memories in `{MEMORY_CONTEXT}` |
| `retrieval_max_tokens` | number | Token budget for memory context |
| `retrieval_min_score` | number (0.0–1.0) | Minimum composite score threshold |
| `retrieval_recency_halflife_days` | number | Recency decay half-life |

**Scoring Weights** (special treatment):
| Field | Type | Weight |
|---|---|---|
| `weight_similarity` | slider | Default 0.45 |
| `weight_recency` | slider | Default 0.20 |
| `weight_importance` | slider | Default 0.20 |
| `weight_access` | slider | Default 0.15 |

Visual: Four linked sliders that display as a stacked bar chart. A validation indicator shows whether they sum to 1.0. If they don't, show a warning: "⚠ Weights sum to 0.95 — should be 1.0".

**Evolution (Pipeline E)**:
| Field | Type | Description |
|---|---|---|
| `evolution_enabled` | toggle | Enable/disable A-MEM linking |
| `evolution_max_neighbors` | number | Max neighbors to consider |
| `evolution_link_threshold` | number (0.0–1.0) | Min similarity for linking |

**Reflection (Pipeline D)**:
| Field | Type | Description |
|---|---|---|
| `reflection_enabled` | toggle | Enable/disable periodic reflection |
| `reflection_interval_hours` | number | Hours between reflection runs |
| `reflection_min_episodes` | number | Min new episodes to trigger |

**Signals (Pipeline C)**:
| Field | Type | Description |
|---|---|---|
| `signal_delay_ms` | number | Delay before signal collection (ms) |
| `signal_no_response_timeout_ms` | number | Timeout for "no response" signal (ms) |

### 7.3 Save Behavior

- **Save** button calls `PUT /config` with changed fields only
- After save, re-fetches `GET /config` to show the effective merged config
- Each field shows a subtle source indicator: `env` (from environment variable) or `override` (persisted to MongoDB)
- **Reset to Defaults** button clears all persisted overrides

---

## 8. Chat Integration

### 8.1 Memory Context Indicator (Web Chat Only)

**Backend change**: Modify `POST /chats/:id/messages` in `chatRoutes.ts` to return memory metadata alongside the response. The `routeMessage()` function already has the `memoryResult` object; we just need to pass summary metadata through.

New field in the chat response:
```typescript
// Added to the sendMessage response
memory_meta?: {
  memories_used: number;
  facts_used: number;
  reflections_used: number;
  profile_loaded: boolean;
  // Only included for web_chat; omitted for Slack/Discord
  memory_context?: string;  // The actual {MEMORY_CONTEXT} string
}
```

**Frontend (ChatDetail.tsx)**: On each assistant message bubble, if `memory_meta` is present and `memories_used > 0`, show a subtle expandable indicator:

```
┌─ Assistant message ──────────────────────────────────────────┐
│ TypeScript strict mode can be enabled by adding...           │
│                                                              │
│ 🧠 3 memories used (2 facts, 1 reflection) · profile loaded │
│ ▾ Show memory context                                        │
└──────────────────────────────────────────────────────────────┘
```

Clicking "Show memory context" expands to show the actual formatted memory context that was injected into the system prompt (the `- [fact, learned Mar 15] ...` lines). This is the raw `{MEMORY_CONTEXT}` string.

When `memories_used === 0`, show nothing (no indicator at all — don't clutter).

### 8.2 Slack/Discord Metadata

For Slack and Discord, the memory metadata is **not** included in the reply text. The system works silently. However, the episode recorded from Slack/Discord interactions is fully visible in the Episodes timeline in the web UI, including all signals detected.

If in the future we want ambient awareness in Slack, we could optionally add a thread-level reaction (e.g., 🧠 emoji) when memories are used, but this is out of scope for v1.

---

## 9. Component Architecture

### 9.1 New Files

```
src/ui/src/components/memory/
├── MemoryPage.tsx              # Main container with sub-tab navigation
├── MemoryDashboard.tsx         # Stats cards, activity feed, quick actions
├── MemoryBrowser.tsx           # Search, filter, paginated memory list
├── MemoryCard.tsx              # Single memory card (reused across views)
├── MemoryDetail.tsx            # Expanded memory detail (links, episodes, edit)
├── MemorySearchBar.tsx         # Search input + filter controls
├── ScoreBreakdown.tsx          # Visual composite score breakdown
├── EpisodesList.tsx            # Filtered, paginated episode timeline
├── EpisodeCard.tsx             # Single episode card with signals
├── EpisodeDetail.tsx           # Expanded episode detail
├── SignalBadge.tsx             # Colored signal type indicator (reusable)
├── UserProfile.tsx             # Profile viewer + edit + regenerate
├── MemoryConfigEditor.tsx      # Runtime config editor with sliders
└── WeightSliders.tsx           # Linked weight sliders with sum validation
```

### 9.2 API Functions (additions to `api.ts`)

```typescript
// ─── Memory System ─────────────────────────────────────────
export interface MemoryNote { /* from shared/memoryTypes.ts */ }
export interface InteractionEpisode { /* from shared/memoryTypes.ts */ }
export interface MemorySearchResult { /* from shared/memoryTypes.ts */ }
export interface MemoryConfig { /* from shared/memoryTypes.ts */ }
export interface OutcomeSignal { /* from shared/memoryTypes.ts */ }

// Stats
export async function getMemoryStats(): Promise<MemoryStats>

// Memories CRUD
export async function listMemoryNotes(params: {
  type?: string; limit?: number; offset?: number; tag?: string;
}): Promise<{ memories: MemoryNote[]; total: number }>

export async function getMemoryNote(id: string): Promise<{
  memory: MemoryNote; linked: MemoryNote[];
}>

export async function searchMemoryNotes(params: {
  query: string; owner?: string; memory_types?: string[];
  tags?: string[]; limit?: number; min_score?: number;
}): Promise<{ results: MemorySearchResult[] }>

export async function editMemoryNote(id: string, updates: {
  content?: string; importance?: number; tags?: string[];
}): Promise<{ memory: MemoryNote }>

export async function invalidateMemoryNote(id: string): Promise<{ ok: boolean }>

// Profile
export async function getMemoryProfile(owner?: string): Promise<{
  profile: MemoryNote | null;
}>

// Reflection
export async function triggerReflection(owner?: string): Promise<{
  result: { episodes_reviewed: number; clusters_found: number;
    reflections_created: number; profile_updated: boolean };
}>

// Episodes
export async function listMemoryEpisodes(params: {
  limit?: number; offset?: number; action?: string;
}): Promise<{ episodes: InteractionEpisode[]; total: number }>

export async function getMemoryEpisode(id: string): Promise<{
  episode: InteractionEpisode; memories: MemoryNote[];
}>

// Config
export async function getMemoryConfig(): Promise<{ config: MemoryConfig }>
export async function updateMemoryConfig(
  overrides: Partial<MemoryConfig>
): Promise<{ config: MemoryConfig }>
```

### 9.3 Modifications to Existing Files

| File | Change |
|---|---|
| `App.tsx` | Add Memory NavTab + route |
| `api.ts` | Add all memory API functions (§9.2) |
| `ChatDetail.tsx` | Add `MemoryContextIndicator` on assistant messages |
| `api.ts` (sendMessage) | Handle new `memory_meta` field in response |

### 9.4 Backend Changes Required

| File | Change |
|---|---|
| `src/server/chat/chatRoutes.ts` | Return `memory_meta` in `POST /:id/messages` response |
| `src/server/slack/messageRouter.ts` | Return memory metadata from `routeMessage()` |

The `routeMessage` function already computes `memoryResult` (containing `memoryContext` and `userContext`). We just need to:
1. Count how many memories were used (count `\n` in `memoryContext` + 1 if non-empty)
2. Pass this metadata back through the call chain
3. Include it in the web chat JSON response

---

## 10. Implementation Phases

### Phase A: Foundation (API + Nav + Dashboard)
1. Add all memory API functions to `api.ts`
2. Create `MemoryPage.tsx` with sub-tab navigation
3. Create `MemoryDashboard.tsx` with stat cards + quick actions
4. Add Memory NavTab to `App.tsx` with route
5. Create `SignalBadge.tsx` shared component

### Phase B: Memory Browser
1. Create `MemoryCard.tsx` and `MemoryDetail.tsx`
2. Create `MemorySearchBar.tsx` with filters
3. Create `ScoreBreakdown.tsx`
4. Create `MemoryBrowser.tsx` assembling the above
5. Wire edit + invalidate actions

### Phase C: Episodes Timeline
1. Create `EpisodeCard.tsx` and `EpisodeDetail.tsx`
2. Create `EpisodesList.tsx` with filters + pagination

### Phase D: Profile + Config
1. Create `UserProfile.tsx` with edit + regenerate
2. Create `WeightSliders.tsx`
3. Create `MemoryConfigEditor.tsx`

### Phase E: Chat Integration
1. Backend: modify `routeMessage()` to return memory metadata
2. Backend: modify `chatRoutes.ts` to include `memory_meta` in response
3. Frontend: add `MemoryContextIndicator` to `ChatDetail.tsx` message bubbles

### Phase F: Dashboard Activity Feed
1. Implement the interleaved activity feed in `MemoryDashboard.tsx`
2. Wire navigation from feed items to memory/episode details

---

## 11. Zero States

Every view needs a graceful zero-state:

| View | Zero State |
|---|---|
| Dashboard (no data) | "The memory system is active but hasn't recorded any interactions yet. Start chatting to see memories appear here." |
| Dashboard (disabled) | Yellow banner: "Memory system is disabled. [Enable]" |
| Memory browser (empty) | "No memories yet. Facts will be extracted automatically as you interact with Steve via chat, Slack, or Discord." |
| Memory search (no results) | "No memories match your query. Try broader terms or adjust the minimum score." |
| Episodes (empty) | "No interaction episodes recorded yet. Episodes are created automatically from every Slack, Discord, and web chat interaction." |
| Profile (no profile) | "No user profile synthesized yet. Profiles are generated during reflection after 10+ episodes. [Run Reflection Now]" |
| Config | Always shows defaults — never empty |

---

## 12. Signal Badge Reference

For consistent rendering across Episodes, Dashboard, and future Chat integration:

| Signal | Emoji | Color | Strength | Tooltip Detail |
|---|---|---|---|---|
| `continuation` | ➡️ | `var(--fg3)` | +0.2 | "User continued the conversation" |
| `gratitude` | 😊 | `var(--green)` | +0.8 | "User expressed thanks or approval" |
| `correction` | ❌ | `var(--red)` | -0.6 | Shows the correction text from `details` |
| `rephrase` | 🔄 | `#f97316` (orange) | -0.4 | Shows similarity score from `details` |
| `follow_up_deeper` | 📈 | `var(--accent)` | +0.4 | Shows similarity score from `details` |
| `topic_change` | 🔀 | `var(--fg3)` | 0.0 | "User changed topic" |
| `no_response` | 🔇 | `var(--fg3)` | -0.1 | "No follow-up within timeout" |
| `job_completed` | ✅ | `var(--green)` | +1.0 | Shows task_id from `details` |
| `job_failed` | 💥 | `var(--red)` | -0.5 | Shows error preview from `details` |
| `explicit_positive` | ⭐ | `var(--green)` | +0.9 | "Explicit positive feedback" |
| `explicit_negative` | 👎 | `var(--red)` | -0.9 | "Explicit negative feedback" |

---

## 13. Type Badge Reference

| Memory Type | Label | Color |
|---|---|---|
| `fact` | FACT | `#3b82f6` (blue) |
| `reflection` | REFLECTION | `#a855f7` (purple) |
| `user_profile` | PROFILE | `#22c55e` (green) |

---

## 14. What's Explicitly Out of Scope (v1)

- **Graph visualization** — A-MEM memory links are shown as lists, not as an interactive force-directed graph. Graph viz is a future enhancement.
- **Real-time updates** — Dashboard uses polling (same as Jobs), not WebSocket push. Polling interval: 30 seconds.
- **Bulk operations** — No bulk invalidation, bulk tag editing, or bulk export. Single-memory operations only.
- **Slack/Discord emoji reactions** — No 🧠 emoji on Slack messages when memory is used. Silent learning only.
- **Memory import/export** — No backup/restore UI.
- **Multi-user memory isolation** — The UI assumes a single owner context (from `config.slackJobOwner`).
