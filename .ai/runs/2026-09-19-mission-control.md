# Execution plan — Mission Control swarm view

Source doc: .ai/specs/2026-09-18-mission-control.md
Refs: #1 (spec revision PR, not yet merged — spec materialized locally into this worktree from
`origin/docs/mission-control-spec-revision`, never committed on this branch)

## Goal

Ship a new global `/mission-control` route offering a Grid/Radar tile view and a Swarm Graph
view of every in-flight run across every registered project, built entirely on data sources that
already aggregate the workspace (`GET /workspace/runs-index`, workspace SSE, per-run SSE,
`buildTaskTree`). One small additive contract field (`missionControlView`) persists the chosen
mode; no other backend/contract changes.

## Scope

- New route `packages/web/src/routes/mission-control/*` (route, grid, graph, agent tile,
  `task-tree-to-flow.ts`, `use-visible-run-events.ts`), lazy-loaded from `routes.tsx`.
- Nav entry in `app-shell.tsx` (plain `RouterLink`, multi-project guard) and
  `command-palette.tsx` (same guard).
- Explicit-project variant of the per-run SSE stream (`packages/web/src/api/run-events.ts` +
  `packages/api-client` project-scope helper) so a tile outside the boot project can subscribe
  correctly.
- `packages/contract/src/workspace.ts`: `missionControlView: z.enum(['grid','graph']).optional()`
  named on both `workspaceUiStateSchema` and `setWorkspaceUiStateInputSchema`.
- New deps: `@xyflow/react`, `dagre` (packages/web only), lazy-loaded.
- Tests for every phase (grid rendering/sorting, visibility-conditional SSE hook, pure
  tree-to-flow transform, toggle state persistence across Grid⇄Graph).

## Non-goals

- Filtering/search in the grid, per-project Mission Control, graph layout persistence,
  export/screenshot, virtualization beyond ~10-20 visible, and any edit actions from a
  tile/node — all explicitly out of scope per the spec's "Out of scope for MVP".
- No backend route changes; no changes to `buildTaskTree`, `useRunsIndex`, or the workspace SSE
  reconciliation.

## Risks

- `useRunEvents`'s ambient project scope is unsafe on a global route (spec: Risks, Critical) —
  addressed in Phase 2 via an explicit-project parameter, mirroring the existing
  `archiveProjectRun`/`getProjectRun` "EXPLICIT project" pattern in `api/client.ts`.
- New graph dependency bundle weight — mitigated via `lazy()` at the route and Graph-module level.
- Visibility-conditional SSE subscription lifecycle (IntersectionObserver) is new to this repo —
  needs explicit unmount/visibility-change tests, not just the happy path.

## Implementation Plan

### Phase 1 — Grid/Radar

1. Add `<Route path="/mission-control">` (lazy) in `routes.tsx`; a minimal `MissionControlRoute`
   rendering `useRunsIndex()` and a list of run titles.
2. Build `AgentTile` + `mission-control-grid.tsx` (CSS grid, active section, collapsible
   "recently finished" section, subtask badge via `buildTaskTree`).
3. Nav entry in `app-shell.tsx` and `command-palette.tsx`, both under the `multiProject` guard.
4. Empty states (`CenteredState`) and the `truncated` hint.
5. Tests: Grid renders from `RunIndexEntry[]` fixtures — status→color/animation mapping,
   active/finished sorting, subtask badge.

### Phase 2 — Live tool-call thumbnail

6. Explicit-project variant of the per-run event stream; `use-visible-run-events.ts`
   (IntersectionObserver + that variant), subscribing only to visible `running` tiles.
7. Wire the thumbnail into `AgentTile`.
8. Tests: subscription start/stop on viewport enter/exit and status change; no dangling
   subscription after unmount.

### Phase 3 — Swarm Graph

9. Add `@xyflow/react` + `dagre` to `packages/web`; lazy-load the Graph module.
10. `task-tree-to-flow.ts`: pure `TaskTreeNode<RunIndexEntry>[]` → `{nodes, edges}`; unit tests.
11. `mission-control-graph.tsx`: custom node, animated/static edges, isolated nodes for
    non-dispatched runs.
12. Grid⇄Graph toggle in `mission-control-route.tsx`, mode persisted via
    `useWorkspaceUiState()`'s new field, highlighted run preserved across the switch.
13. Test: render `MissionControlRoute`, toggle Grid→Graph→Grid, assert the highlighted/selected
    run survives both switches.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not
> rename step titles.

### Phase 1: Grid/Radar

- [x] 1.1 Route + minimal MissionControlRoute — 8008c92a
- [x] 1.2 AgentTile + mission-control-grid.tsx — 8008c92a
- [x] 1.3 Nav entry (app-shell + command-palette) — 8008c92a
- [x] 1.4 Empty states + truncated hint — 8008c92a
- [x] 1.5 Grid tests — 8008c92a

### Phase 2: Live tool-call thumbnail

- [ ] 2.1 Explicit-project per-run SSE variant + use-visible-run-events.ts
- [ ] 2.2 Wire thumbnail into AgentTile
- [ ] 2.3 Visibility/subscription tests

### Phase 3: Swarm Graph

- [ ] 3.1 Add @xyflow/react + dagre, lazy-load Graph module
- [ ] 3.2 task-tree-to-flow.ts + unit tests
- [ ] 3.3 mission-control-graph.tsx
- [ ] 3.4 Grid⇄Graph toggle + mode persistence
- [ ] 3.5 Toggle-survives-highlight test
