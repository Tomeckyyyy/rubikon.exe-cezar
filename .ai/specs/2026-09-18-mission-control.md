# Mission Control — visual swarm view

Date: 2026-09-19
Author: Wiktor Idzikowski (brainstormed with Claude, spec by Claude Code)
Status: ready for `writing-plans`

## 📝 TLDR

The current Tasks view (a table) works well for hands-on work, but becomes
unreadable once a dozen-plus parallel runs are in flight at once — an
increasingly common scenario since dispatch
(`.ai/specs/2026-09-10-dispatch.md`). Mission Control is a new, **global**
(cross-project), purely front-end view offering two visualizations of the
same state — **Grid/Radar** (tiles) and **Swarm Graph** (the dispatch tree as
an animated graph) — built entirely on data sources that already aggregate
the whole workspace (`GET /workspace/runs-index`, workspace SSE, per-run SSE,
`buildTaskTree`). No backend or core contract changes beyond one small,
additive UI-state field.

## 📝 Problem Statement

- The Tasks table scales cognitively to a handful of parallel runs; beyond
  that (dispatch can expand one task into a tree of up to
  `DISPATCH_MAX_SUBTASKS = 50` subtasks) the user loses track of "what's
  happening right now," and there is no dedicated view for a demo/stage
  moment ("dozens of agents tamed in one place").
- The exact raw material for this already exists: `GET /workspace/runs-index`
  (aggregates every registered project, with `dispatch`, `costUsd`, `usage`
  per row) and `buildTaskTree` (a pure, already-tested builder of the tree
  from `rootRunId`/`parentRunId` relations). Nobody visualizes this today as
  a graph or a tile grid — `GlobalTasksRoute` renders the same data as a
  flat/nested table.

## 📝 Proposed Solution

A new global route, `/mission-control`, alongside the existing `/tasks`
(`GlobalTasksRoute`), reading the same data (`useRunsIndex` + workspace SSE),
with a **Grid ⇄ Swarm Graph** toggle:

1. **Grid/Radar** — a responsive tile grid, one tile per run, animated
   status, live cost/tokens, a subtask-count badge, a thumbnail of the last
   tool call for visible, `running` tiles.
2. **Swarm Graph** — an animated dispatch-tree graph: a root node (root run)
   branching to subtasks, colored/animated by status, isolated nodes for
   runs with no dispatch.

Alternative rejected: a per-project view (`/p/:projectId/mission-control`,
mirroring `tasks-overview.tsx`). Rejected because a single project rarely
has enough concurrent runs to justify a dedicated visualization — the
business goal ("dozens of agents in one place") requires the same
cross-project scope as `GlobalTasksRoute`.

## 📝 Architecture

- **No backend/core changes, and only one small, additive contract field**
  (see Data Model). A pure overlay on existing, already-aggregating
  workspace sources:
  - `GET /workspace/runs-index` via `useRunsIndex()`
    (`packages/web/src/api/queries.ts:793`) — the same function
    `GlobalTasksRoute` uses, so no second fetch or cache for the same data.
    `RunIndexEntry` (`packages/contract/src/runs.ts:335-408`) already carries
    everything needed: `projectId`, `dispatch: {rootRunId, parentRunId, kind}`,
    `costUsd`, `usage: ProcessUsage` (cpu/rss, live), `status`, `activity`.
  - The same `/api/workspace/events` (one global SSE, `global-events.tsx`)
    reconciles `workspaceQueryKeys.runsIndex` on `run`/`usage` events —
    Mission Control opens nothing new, it gets refreshes for free through the
    same mechanism as `GlobalTasksRoute`.
  - The dispatch hierarchy → `buildTaskTree`
    (`packages/web/src/lib/task-tree.ts`), reused unchanged; it operates on
    the structural shape `{id, dispatch?}`, so `RunIndexEntry[]` fits
    directly. **This is exclusively the dispatch tree (runs-to-runs)** — not
    the same thing as the in-session sub-agent grouping from
    `.ai/specs/2026-07-20-grouped-subagent-display.md` (a dock + drill-down
    sheet, a separate mechanism with a separate data source rooted in
    `ui-event`). Mission Control does not touch or replace it.
- **Routing and navigation** (global scope, outside `/p/:projectId`, like
  `/tasks`):
  - `routes.tsx`: a new `<Route path="/mission-control" element={<MissionControlRoute />} />`
    next to the `/tasks` entry (routes.tsx:559), lazy-loaded
    (`lazy(() => import(...))`, the pattern at routes.tsx:41-79) — the new
    graph dependency must not land in the main bundle.
  - `app-shell.tsx`: a new nav entry next to `AllTasksLink`
    (app-shell.tsx:669-690) — **a plain `RouterLink`, not the scoped `Link`**
    (the route sits outside `/p/:id`), its own icon (e.g. `NetworkIcon`/
    `RadarIcon`, so it doesn't visually collide with `AllTasksLink`'s
    `LayersIcon`). **Visible only in multi-project mode**, mirroring
    `AllTasksLink`/the palette (command-palette.tsx:439-453, the
    `multiProject` guard) — with a single registered project the view would
    reduce to `tasks-overview.tsx` with no added value.
  - `command-palette.tsx`: an analogous entry in the "Views" group next to
    `"view All tasks"` (line ~448), under the same `multiProject` guard.
- New directory `packages/web/src/routes/mission-control/`:
  - `mission-control-route.tsx` — routing/wiring: `useRunsIndex()`, the
    Grid/Graph toggle, reading/writing the mode in workspace UI state (see
    Data Model).
  - `mission-control-grid.tsx` — the Grid view.
  - `mission-control-graph.tsx` — the Swarm Graph view.
  - `agent-tile.tsx` — the shared tile component, also used as the content
    of a custom node in the graph.
  - `task-tree-to-flow.ts` — a pure function
    `taskTreeToFlow(buildTaskTree(runs))` → `nodes[]`/`edges[]` for
    react-flow. `task-tree.ts` stays unchanged.
  - `use-visible-run-events.ts` — a hook for conditionally subscribing to
    per-run SSE for visible, `running` items (a new pattern — the repo has
    no existing `IntersectionObserver` usage today, so this must be designed,
    not copied). **Cannot use `useRunEvents` as-is** — see below.

**Project-scope pitfall in per-run SSE.** `useRunEvents`
(`packages/web/src/api/run-events.ts`) builds its URL through `apiPath()`/
`getApiScope()`, which read an AMBIENT, module-level `activeProjectId` set by
`ProjectScopeProvider` from the `/p/:projectId` route param. On the global
`/mission-control` route (outside `/p/:projectId`) that scope is
undefined/boot-project, regardless of which project a given row actually
belongs to (`RunIndexEntry.projectId`) — exactly the problem `global-tasks.tsx`
already solved once for REST calls (`archiveProjectRun`, `getProjectRuns` and
other functions in `api/client.ts` marked "EXPLICIT project", deliberately
bypassing the ambient scope). No such explicit-project variant exists today
for the per-run event stream. Phase 2 therefore requires adding an
**explicit-project** variant of the per-run event stream (a new hook, or a
parameter on `useRunEvents` that builds the URL from an explicitly passed
`projectId` instead of the ambient scope) — without it, a tile for a run
outside the boot project will either get no events at all or, on an id
collision, show another project's run. This blocks Phase 2, not Phase 1 (the
Grid without the tool-call thumbnail never touches `useRunEvents`).

By contrast, `usage` (CPU/RSS) on a tile is safe without this fix — it rides
the single, workspace-level `/workspace/events` connection
(`global-events.tsx`), which has no per-project scope and doesn't share this
problem.

- **New dependency:** `@xyflow/react` (react-flow, without `MiniMap`) +
  `dagre` (or an equivalent simple per-level layout) for Swarm Graph. The
  repo has no graph/node-link library today — a deliberate, isolated new
  dependency for this one view, lazy-loaded.

## 📝 Data Model

No new entities, but **one small, additive `packages/contract` change**: UI
state for the Grid/Graph mode.

- **Grid/Graph mode, per workspace** — persisted the same way column
  visibility is today
  (`.ai/specs/2026-07-30-foldable-task-table-columns.md`):
  `~/.cezar/ui-state.json` via `useWorkspaceUiState()`
  (`packages/web/src/api/queries.ts:1171`, `workspaceQueryKeys.uiState`,
  optimistic update + debounced PUT). **Not** localStorage — this describes a
  preference of the person using the cockpit, not repo data, exactly the same
  rule as for columns.
- `workspaceUiStateSchema`/`setWorkspaceUiStateInputSchema`
  (`packages/contract/src/workspace.ts`) are `z.looseObject`s today: a field
  outside the named keys round-trips via passthrough, but untyped and
  unvalidated. Exactly the same situation `taskTable.expandedColumns` was in
  for foldable columns: that feature added it as a **named, bounded field on
  both schemas**, instead of relying on passthrough. Mission Control does the
  same: `missionControlView: z.enum(['grid', 'graph']).optional()` added to
  both schemas in the same commit as the rest of Phase 3 — per the AGENTS.md
  rule "every request/response shape is a zod schema... never hand-write an
  API type," instead of reading/writing the value as `unknown` with a
  client-side cast.

## 📝 API Contracts

No new endpoints. One schema change (see Data Model): `missionControlView` as
a named field on `workspaceUiStateSchema` and
`setWorkspaceUiStateInputSchema`. Reused as-is otherwise:

- `GET /workspace/runs-index` (`runsIndexResponseSchema`, existing).
- `GET /workspace/events` (SSE, existing) for `runsIndex` refreshes.
- `GET /runs/:id/events` (per-run SSE, existing endpoint) for the last
  tool-call thumbnail — opened conditionally, only for visible, `running`
  tiles/nodes, through the explicit-project variant described above (see
  `use-visible-run-events.ts`).
- `GET`/`PUT` workspace UI state (existing, `useWorkspaceUiState`) for
  remembering the Grid/Graph mode.

## 📝 UI/UX

### Grid / Radar

- A responsive CSS grid (`grid-template-columns: repeat(auto-fill, minmax(...))`).
  Active runs (`queued`/`running`/`waiting`/`review`) on top; finished ones
  (`done`/`failed`/`cancelled`) collapsed into a default-hidden "recently
  finished" section.
- `AgentTile` renders: the task title, project name/color (`projectId` from
  `RunIndexEntry`, joined against `useProjects()` — as `GlobalTasksRoute`
  already does), workflow/model; status as color + animation (pulsing border
  for `running`, a slower pulse for `queued`, an amber accent for
  `waiting`/`review`, static for terminal states); `costUsd` (live via cache
  reconciliation on `run` events, not via `usage` SSE — see the Risks
  section) and optionally `usage` (CPU/RSS, live from `usage` SSE) if it
  turns out to add value on the tile; a subtask-count badge
  (`descendantCount` from `buildTaskTree`); a last-tool-call thumbnail, only
  when available from per-run SSE.
- Clicking a tile navigates to the existing run-detail view (scoped to its
  `projectId`) — nothing new to build on the drill-down side.

### Swarm Graph

- Custom node type = a simplified `AgentTile` (title, status color/animation,
  mini cost).
- Edges: `animated: true` for branches whose child is still
  `running`/`queued`; static for finished ones.
- Runs with no parent and no children (standalone, not dispatched) — separate
  isolated nodes/islands on the same canvas; the graph never drops "plain"
  tasks outside dispatch trees.
- Clicking a node → the same drill-down as Grid.

### Empty/error states

- No active runs anywhere in the workspace: a "no agents in action"
  placeholder (reuse `CenteredState`, the pattern from `global-tasks.tsx`).
- `truncated` from `runsIndexResponseSchema` (projects whose run list was
  capped): show a subtle hint that not every task from every project is
  visible here — `GlobalTasksRoute` already has a precedent for this to copy.

## 📝 Edge Cases & Failure Scenarios

- Per-run SSE disconnect for a tool-call: the tile/node stops updating,
  shows the last known value with a subtle "stale" mark — no error blocking
  the whole view. `useRunEvents` already has reconnect/watchdog logic.
- Global workspace SSE disconnect: the same degradation `GlobalTasksRoute`
  already has today (interval backstop + reconcile on `visibilitychange`) —
  Mission Control changes nothing here, it inherits `useRunsIndex`'s
  behavior.
- Deeply nested or very large trees (beyond the assumed 10-20 visible at
  once, given the hard dispatch limit `DISPATCH_MAX_SUBTASKS = 50`): the view
  doesn't crash, it scales via react-flow pan/zoom / grid scrolling —
  explicitly documented as a known MVP limitation.
- A single registered project: the nav entry and palette item are hidden
  (`multiProject` guard) — the view stays reachable only via a direct URL,
  which is acceptable (no added value over `tasks-overview.tsx` for one
  project).

## 📝 Risks & Impact Review

- **Critical: `useRunEvents` is not usable on a global route without
  changes.** It builds its URL through the ambient, module-level
  `activeProjectId` (`ProjectScopeProvider`, set from `/p/:projectId`), so on
  `/mission-control` (outside `/p/:projectId`) every per-run SSE will target
  the boot project, not the actual `RunIndexEntry.projectId` of that row —
  for a run outside the boot project, the tool-call thumbnail either gets no
  events or, on an id collision, shows another run's events.
  `global-tasks.tsx` already solved the identical problem for REST (explicit
  `…project…` functions in `api/client.ts`, marked "EXPLICIT project",
  bypassing the ambient scope) — for per-run SSE such a variant doesn't exist
  yet and must be built as part of Phase 2 (see Architecture and plan step
  6). Does not block Phase 1 (Grid without the tool-call thumbnail never
  touches `useRunEvents`). This applies only to the per-run stream; the
  workspace-level `usage` stream has no per-project scope and is unaffected.
- New runtime dependency (`@xyflow/react` + layout): grows the bundle;
  mitigated via `lazy()`, loaded only when someone enters `/mission-control`
  and only for Graph mode (the graph module can additionally be
  lazy-split from the Grid).
- Beyond the added `missionControlView` field (Data Model), no
  contract/backend changes → no backward-compatibility risk
  (`BACKWARD_COMPATIBILITY.md` untouched), since the field is new and
  optional.
- `use-visible-run-events.ts` is the one genuinely new mechanism
  (visibility-conditional SSE subscription) — risk: a badly written cleanup
  leaves dangling `useRunEvents`-style subscriptions on fast
  scrolling/Grid⇄Graph switching. Needs a test for unmount/visibility-change,
  not just the happy path.

## 📋 Phasing

- **Phase 1 — Grid/Radar.** Route, nav, `useRunsIndex`, `AgentTile` without
  the tool-call thumbnail, without per-run SSE. Fully useful on its own —
  already solves the core problem (an overview of many parallel runs).
- **Phase 2 — Live tool-call on the tile.** `use-visible-run-events.ts` +
  IntersectionObserver, wired into the Phase 1 Grid.
- **Phase 3 — Swarm Graph.** New dependency (`@xyflow/react` + layout),
  `task-tree-to-flow.ts`, the Grid⇄Graph toggle, mode persistence in
  workspace UI state.

Each phase ships independently and leaves the app in a working state. Worth
considering during planning: since Phase 3 (Swarm Graph) carries its own
non-trivial dependency (`@xyflow/react` + layout) and a different visual
paradigm than Phases 1-2, it could be split off into a separate follow-up
spec written after real Grid usage data exists, instead of committing to this
library upfront — that's a product call for the author, not a blocker for
the rest of this spec.

## 📋 Implementation Plan

### Phase 1 — Grid/Radar

1. Add `<Route path="/mission-control">` (lazy) in `routes.tsx`, an empty
   `MissionControlRoute` rendering `useRunsIndex()` and a list of run titles
   (smoke-testable right away).
2. Build `AgentTile` (title, project, workflow, status color/animation,
   `costUsd`, subtask badge from `buildTaskTree`) + `mission-control-grid.tsx`
   (CSS grid, an "active" section / a collapsible "recently finished" one).
3. Add the nav entry in `app-shell.tsx` (plain `RouterLink`, `multiProject`
   guard) and the entry in `command-palette.tsx` under the same guard.
4. Empty states (`CenteredState`) and the `truncated` hint from
   `runsIndexResponseSchema`.
5. Tests: render the Grid with `RunIndexEntry[]` fixtures (status → color/
   animation mapping, active/finished sorting, subtask badge).

### Phase 2 — Live tool-call

6. Add an explicit-project variant of the per-run event stream (a new hook,
   or a parameter on `useRunEvents` that builds the URL from an explicitly
   passed `projectId` instead of the ambient `activeProjectId` from
   `/p/:projectId`) — required because `/mission-control` is a global route
   (see Risks: Critical). Then `use-visible-run-events.ts`: an
   IntersectionObserver hook + that variant, subscribing only to visible
   `running` tiles (using their own `projectId` from `RunIndexEntry`),
   unsubscribing on visibility loss or a status change.
7. Wire it into `AgentTile` as an optional thumbnail ("🔧 Read src/foo.ts").
8. Tests: the subscription starts/ends correctly on viewport enter/exit and
   on a status change away from `running`; no dangling subscription after
   unmount.

### Phase 3 — Swarm Graph

9. Add `@xyflow/react` + `dagre` as dependencies of `packages/web`, lazy-load
   the Graph module itself.
10. `task-tree-to-flow.ts`: a pure function
    `TaskTreeNode<RunIndexEntry>[]` → `{nodes, edges}`; unit tests without
    rendering UI (a deterministic transformation, easy to cover — mirroring
    `task-tree.test.ts`).
11. `mission-control-graph.tsx`: the custom node (a simplified `AgentTile`),
    animated/static edges based on the child's status, isolated nodes for
    runs without dispatch.
12. The Grid⇄Graph toggle in `mission-control-route.tsx`, mode state in
    `useWorkspaceUiState()` (the new field), preserving the highlighted run
    across the switch.
13. Test (RTL, not manual — this is a plain state/render assertion): render
    `MissionControlRoute`, toggle Grid→Graph→Grid, assert the
    highlighted/selected run survives both switches. Manual visual
    verification in the browser remains a supplement, not a replacement for
    this test.

## 📝 Out of scope for MVP

- Filtering/search in the grid.
- Saving/remembering the graph layout between sessions.
- Export/screenshot of the view.
- Virtualization/canvas for hundreds of agents at once (beyond ~10-20
  visible simultaneously).
- Actions/editing from a tile or a node (beyond navigating to run details).
- A per-project view (see Proposed Solution — rejected as an alternative,
  not deferred as "later").

## 📝 Related specs

- `.ai/specs/2026-09-10-dispatch.md` — the dispatch/subagent tree model, the
  source of the hierarchy Swarm Graph visualizes; the
  `DISPATCH_MAX_IN_FLIGHT`/`DISPATCH_MAX_SUBTASKS` limits.
- `.ai/specs/2026-07-20-grouped-subagent-display.md` — the in-session
  sub-agent grouping mechanism (dock + sheet); explicitly distinct from the
  dispatch tree Mission Control visualizes.
- `.ai/specs/004-cockpit-tasklist.md` — where `costUsd`/`usage` on a run row
  come from.
- `.ai/specs/2026-07-30-foldable-task-table-columns.md` — the pattern for
  persisting UI preferences in `~/.cezar/ui-state.json`, reused for the
  Grid/Graph mode.
- `.ai/specs/2026-07-30-session-usage-metrics.md`
