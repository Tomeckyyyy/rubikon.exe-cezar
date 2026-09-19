# Workflow outcome stats — per-project, technical-only aggregation

## TLDR

Show, per project, how each `(workflow, runner, model)` combination has actually turned out across
its retained run history: how many runs landed in each terminal status (`done`, `review`, `failed`,
`cancelled`), a failed-rate, and average duration/tokens/cost. Computed entirely client-side from
data the cockpit already fetches (`useRuns()` → `ApiRun[]`) — **no new backend route, no new
contract schema, no new persisted state**. This is deliberately the narrow, honest half of "learn
from run history": it measures engine-level outcomes only, never claims to measure whether the work
was any good, because cezar has no signal for that yet (see "Not done" below).

## Why this shape, not a fuller "which workflow succeeds" feature

`RunRecord.status` (`packages/cezar/src/runs/store.ts:214`) is `queued | running | waiting | review |
done | failed | cancelled`. `review`/`done` mean "reached the engine's terminal state", not "the user
accepted the result" — cezar never auto-merges, and nothing in the codebase tracks whether a run's PR
was later merged, closed, or abandoned (`server/pr.ts`, `server/github.ts` query GitHub live; nothing
writes an outcome back onto the run). Labeling anything here "success rate" would therefore measure
"how often this workflow reaches review" — which for a well-behaved autonomous-free workflow is
*expected* to be near 100%, and would read as a false endorsement. This spec computes and displays
only the signal the data actually supports: the terminal-status mix and cost/duration. Adding a real
merged/closed outcome signal (passive GitHub polling, or an explicit accept/reject at the review
gate) is tracked as a separate, later spec — it is a precondition for any metric that claims to
measure quality, not a variant of this one.

## Scope

- **Per-project only**, matching `useRuns()`'s existing scope (`GET /api/v1/p/:projectId/runs`).
  Cross-project rollups are parked (see "Not done").
- **No time window in v1.** The group is whatever `listRuns()` currently returns for the project —
  bounded already by the existing retention caps (`MAX_RUNS_KEPT` / `MAX_ARCHIVED_KEPT` in
  `runs/store.ts`), so no unbounded growth to worry about. A "last 30 days" filter is a pure UI
  addition later if wanted; not building it now (YAGNI).
- **Dispatch children excluded, dispatch roots kept.** `dispatch.parentRunId` (`packages/contract/
  src/dispatch.ts:85`) is "absent on the root; present on every dispatched child" — so the filter is
  `run.dispatch?.parentRunId !== undefined`, not "any `dispatch` present". A root run that happens to
  use dispatch is still the user's own workflow choice and belongs in the stats; only its spawned
  children (subagent units, not a workflow the user picked) are excluded.
- **Grouping key:** `(workflow, runner ?? 'unknown', modelIdentity ?? model ?? 'default')`. A run
  that switched backend/model mid-thread (spec 0.10.1, "continue on another agent/account") is
  attributed to its *current* stored `runner`/`model` — the same simplification `diffStat` already
  makes by being a single cached number rather than per-step history. Documented as a known
  limitation, not fixed here.

## Data & metrics (pure function, no I/O)

New pure module `packages/web/src/lib/workflow-stats.ts`:

```ts
export interface WorkflowStatsGroup {
  workflow: string
  runner: string
  model: string
  counts: { queued: number; running: number; waiting: number; review: number; done: number; failed: number; cancelled: number }
  terminalTotal: number          // review + done + failed + cancelled
  failedRate: number | undefined // failed / terminalTotal, undefined when terminalTotal === 0
  avgDurationMs: number | undefined   // over terminal runs with both startedAt and finishedAt
  avgTokens: number | undefined       // over terminal runs; undefined if none have tokensUsed
  avgCostUsd: number | undefined      // over terminal runs with costUsd present
}

export function computeWorkflowStats(runs: ApiRun[]): WorkflowStatsGroup[]
```

Rules:
- Skip any run where `dispatch?.parentRunId` is present (a dispatched child).
- `failedRate` is computed but the UI only renders/colors it when `terminalTotal >= 3` — a single
  bad run must not paint a workflow red. Below that threshold, show raw counts only.
- Never call `failedRate`'s complement a "success rate" anywhere — copy says "reached review/done",
  "failed", "cancelled", never "succeeded".
- `avgTokens`/`avgCostUsd` are computed unconditionally (telemetry is always collected per
  `2026-07-28-hide-token-metrics.md`); the **component** decides whether to render them, via the
  existing `usageMetricVisibility(health)` helper (`packages/web/src/lib/token-metrics.ts`) — same
  gate `tasks-overview.tsx` and `compare-variants.tsx` already use. When hidden, the stat cells are
  omitted entirely, not blanked.

## UI placement

A compact stats row added under each saved workflow's entry in `/workflows`
(`packages/web/src/routes/workflows/workflows.tsx`), grouped by workflow (collapsing the
runner/model sub-groups into one line per runner/model when a workflow has been run under more than
one). Rationale: this is where the user already is when deciding whether to trust or edit a
workflow, and it adds no new route, no new nav entry, no new page to maintain. `useWorkflowStats(
runs: ApiRun[])` wraps `computeWorkflowStats` in a `React.useMemo`, fed by the same `useRuns()` query
the tasks list already holds warm — zero extra network requests.

Rendered shape per line: `12 runs · 9 done/review · 2 failed · 1 cancelled · avg 4m12s` (+ `· avg
$0.38` when cost metrics are visible). A workflow with `terminalTotal < 3` shows counts only, no rate
styling.

## Not done (deliberately)

- No merged/closed PR outcome tracking — the real "did this actually work" signal. Separate,
  later spec; this one is explicitly the technical-only half.
- No cross-project aggregation, no time-window filter, no per-skill breakdown (a workflow can chain
  multiple skills across steps; attributing outcome to one skill needs the step-level `workflow`
  definition walked and cross-referenced, which is more machinery than the "cheap" framing of this
  spec allows — worth its own follow-up once this ships and is trusted).
- No backend route, no contract schema, no new persisted field. If a future need (e.g. server-side
  cron digest, CLI report) requires the aggregation off the browser, promote `computeWorkflowStats`
  to a shared location then — not preemptively.

## Testing

- `workflow-stats.test.ts`: pure unit tests over hand-built `ApiRun[]` fixtures — grouping,
  dispatch-child exclusion, `failedRate` undefined at zero terminal runs, the `< 3` display
  threshold, missing `model`/`runner` fallback buckets. Runs under the fast `npm run test:unit`/`npm
  test` gate, no server or browser needed.
- A rendering test in `workflows.test.tsx` (or a new `workflow-stats-row.test.tsx`) confirming the
  cost/token cells disappear when `usageMetricVisibility` reports `false`.
