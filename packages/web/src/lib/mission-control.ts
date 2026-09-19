import type { RunEvent, RunIndexEntry, RunStatus } from '@open-mercato/cezar-api-client'

import { deriveAttention, type AttentionInput } from '@/lib/attention'
import { buildTaskTree, flattenTaskTree } from '@/lib/task-tree'
import type { StatusDotTone } from '@/components/status-dot'

/**
 * Pure presentational logic for the Mission Control Grid/Radar and Swarm Graph
 * (`.ai/specs/2026-09-18-mission-control.md`). Nothing here touches React, the router or a
 * socket — the same split `lib/task-tree.ts`/`lib/global-tasks.ts` already use, so the rules
 * worth testing are testable as plain functions.
 */

/** Every status the Grid treats as "still in flight" — on top, never collapsed. Everything else
 *  (`done`/`failed`/`cancelled`) is a finished outcome and defaults to a collapsed section. */
const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting', 'review'])

export function isActiveRun(run: Pick<RunIndexEntry, 'status'>): boolean {
  return ACTIVE_STATUSES.has(run.status)
}

/**
 * Active runs first (order preserved), finished runs after (order preserved) — what feeds the
 * Grid's active sections and its default-collapsed "recently finished" one. A stable partition,
 * not a re-sort: which active run is "first" is the caller's own ordering (`runs-index` order),
 * exactly like `taskTreeRows` refuses to re-sort what it nests.
 */
export function splitActiveRuns<T extends Pick<RunIndexEntry, 'status'>>(
  runs: readonly T[],
): { active: T[]; finished: T[] } {
  const active: T[] = []
  const finished: T[] = []
  for (const run of runs) (isActiveRun(run) ? active : finished).push(run)
  return { active, finished }
}

/** `waiting`/`review` — the same two statuses `lib/task-groups.ts`'s `bucketOf` calls "Needs you"
 *  for the sidebar quick-list. Named and split out here so the Grid can put a run that is
 *  actually asking for a person ahead of the fifteen others that are simply busy — the board's
 *  whole point is triage, and a flat "Active" pile that treats "blocked on you" and "working fine
 *  on its own" as the same thing asks the viewer to do that sorting by eye instead. */
export function needsYouRun(run: Pick<RunIndexEntry, 'status'>): boolean {
  return run.status === 'waiting' || run.status === 'review'
}

/** Splits an already-active list (`splitActiveRuns`'s own `active`) into "Needs you" and
 *  "Working" — order preserved within each, same stable-partition contract as `splitActiveRuns`. */
export function splitByAttention<T extends Pick<RunIndexEntry, 'status'>>(
  runs: readonly T[],
): { needsYou: T[]; working: T[] } {
  const needsYou: T[] = []
  const working: T[] = []
  for (const run of runs) (needsYouRun(run) ? needsYou : working).push(run)
  return { needsYou, working }
}

/**
 * Oldest-first — the order "Needs you" actually wants. `runs-index` lists newest-created first
 * (so a person searching the palette sees their most recent work), which is exactly backwards for
 * a pile of blocked runs: the one that has been asking the longest is the one to open first, not
 * whichever was dispatched most recently. A separate function rather than baked into
 * `splitByAttention`, matching this module's (and `lib/task-tree.ts`'s) "order is the caller's"
 * rule — a caller that wants runs-index order untouched still can.
 */
export function sortByAge<T extends Pick<RunIndexEntry, 'startedAt' | 'createdAt'>>(
  runs: readonly T[],
): T[] {
  const startedAt = (run: T) => new Date(run.startedAt ?? run.createdAt).getTime()
  return [...runs].sort((a, b) => startedAt(a) - startedAt(b))
}

export type TileStatusPaint = { tone: StatusDotTone; pulse: boolean; label: string }

/**
 * Status → tile paint, via `lib/attention.ts`'s `deriveAttention` — the SAME function the sidebar
 * dot, the Tasks table dot and the thread header use, so "violet pulsing" means "running" and
 * "amber" means "needs you" here exactly as it does everywhere else in the cockpit. An earlier
 * version of this function painted its own status→color table (`running` green, `waiting` AND
 * `review` both amber) that quietly disagreed with the rest of the app — and with Swarm Graph's
 * own in-flight edges, which were already violet. A viewer who has learned the app's status
 * colors elsewhere should not have to relearn a second palette just for this one board.
 */
export function tileStatusPaint(run: AttentionInput): TileStatusPaint {
  const attention = deriveAttention(run)
  return { tone: attention.tone, pulse: attention.pulse, label: attention.label }
}

/** One bucket per row of the fleet's status distribution bar — the same four ideas `deriveAttention`
 *  already ranks (needs you > working > a settled outcome), just counted instead of per-run. */
export interface FleetStatusCounts {
  needsYou: number
  working: number
  done: number
  failed: number
  cancelled: number
}

export interface FleetTotals {
  /** Sum of `costUsd` across runs still IN FLIGHT — "what am I spending right now", not a
   *  lifetime total that would keep climbing long after every agent went quiet. */
  activeCostUsd: number
  statusCounts: FleetStatusCounts
  /** Lifetime cost per project, across every run in the index (active and finished) — the
   *  question "which project has actually cost me the most" has no "right now" version. */
  costByProject: Map<string, number>
}

/** Which of the fleet-status bar's five buckets a run falls into — the SAME rule `fleetTotals`
 *  counts by, pulled out on its own so the bar's segments can also FILTER by it (a click needs to
 *  ask "which runs are in this bucket", not just "how many"). */
export type FleetStatusBucket = keyof FleetStatusCounts

export function statusBucketOf(run: Pick<RunIndexEntry, 'status'>): FleetStatusBucket {
  if (needsYouRun(run)) return 'needsYou'
  if (isActiveRun(run)) return 'working'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'cancelled') return 'cancelled'
  return 'done'
}

/**
 * Every run in the index, reduced to what the fleet-level readout at the top of Mission Control
 * needs (spec follow-up: "management," not just triage) — one pass, pure, so it is testable
 * without mounting anything and cheap enough to recompute on every `runs-index` tick.
 */
export function fleetTotals(runs: readonly RunIndexEntry[]): FleetTotals {
  let activeCostUsd = 0
  const statusCounts: FleetStatusCounts = { needsYou: 0, working: 0, done: 0, failed: 0, cancelled: 0 }
  const costByProject = new Map<string, number>()

  for (const run of runs) {
    if (isActiveRun(run)) activeCostUsd += run.costUsd ?? 0
    statusCounts[statusBucketOf(run)] += 1
    if (run.costUsd) costByProject.set(run.projectId, (costByProject.get(run.projectId) ?? 0) + run.costUsd)
  }

  return { activeCostUsd, statusCounts, costByProject }
}

/** What the fleet panel's click narrows the Grid/Graph down to — never both a project AND a
 *  status at once: this is "drill into one slice," not a general filter builder, and `undefined`
 *  is the ordinary "show everything" state, not a missing feature. */
export type MissionControlFilter =
  | { kind: 'project'; projectId: string }
  | { kind: 'status'; bucket: FleetStatusBucket }
  | undefined

/** A short, human label for the active filter chip (`mission-control-route.tsx`'s header) —
 *  named here, not spelled out at each call site, so the chip's wording and the filter's actual
 *  meaning can never drift apart. */
export function missionControlFilterLabel(
  filter: MissionControlFilter,
  projectName: (projectId: string) => string,
): string | undefined {
  if (filter === undefined) return undefined
  if (filter.kind === 'project') return projectName(filter.projectId)
  const labels: Record<FleetStatusBucket, string> = {
    needsYou: 'needs you',
    working: 'working',
    done: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
  }
  return labels[filter.bucket]
}

/** `runs`, narrowed to the active filter — or the same runs, unchanged, when nothing is selected.
 *  Applied to what the Grid/Graph render; the fleet panel itself always reads the UNFILTERED list
 *  (`mission-control-route.tsx`), so selecting a slice narrows the content below it without also
 *  shrinking the control you just clicked out from under your own next click. */
export function applyMissionControlFilter(
  runs: readonly RunIndexEntry[],
  filter: MissionControlFilter,
): RunIndexEntry[] {
  if (filter === undefined) return [...runs]
  if (filter.kind === 'project') return runs.filter((run) => run.projectId === filter.projectId)
  return runs.filter((run) => statusBucketOf(run) === filter.bucket)
}

/**
 * Direct-child dispatch counts for every run in `runs`, keyed by run id — the tile's "N subtasks"
 * badge. Built once per render off the same `buildTaskTree` every other list already reuses, so
 * the nesting rule (spec 2026-09-10-dispatch) is never re-implemented here.
 */
export function subtaskCounts(runs: readonly RunIndexEntry[]): Map<string, number> {
  const tree = flattenTaskTree(buildTaskTree(runs))
  return new Map(tree.map((node) => [node.run.id, node.childCount]))
}

/** The shape of a protocol-v2 tool item this module reads — deliberately narrow (`title` only):
 *  the full `UiToolItem` (`packages/cezar/src/core/ui-events.ts`) is server-only, and the
 *  thumbnail wants exactly the one field the server already computed once
 *  (`toolDisplay()`, e.g. "Read src/foo.ts"), never a second title-formatting rule on the client. */
interface WireToolItem {
  kind: 'tool'
  title: string
}

function isWireToolItem(value: unknown): value is WireToolItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'tool' &&
    typeof (value as { title?: unknown }).title === 'string'
  )
}

/** protocol-v2 event types that carry a fresh `UiItem` snapshot — the ones worth scanning for a
 *  tool call. `item.delta` never does (it carries `itemId`/a raw string field, not an item). */
const ITEM_SNAPSHOT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'item.started',
  'item.updated',
  'item.completed',
])

/**
 * The most recent tool call's display title out of a per-run event stream — Mission Control's
 * live "🔧 Read src/foo.ts" tile thumbnail (spec 2026-09-18-mission-control, Phase 2).
 *
 * Scans from the END: `useRunEvents` returns every frame seen so far in arrival order, and only
 * the LATEST tool item is ever shown — a tile is a glance, not a transcript. Returns `undefined`
 * when the stream has produced nothing yet, which is a normal, complete state (Phase 1's tile
 * renders identically with no thumbnail at all).
 */
export function lastToolCallTitle(events: readonly RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (!ITEM_SNAPSHOT_EVENT_TYPES.has(event.type)) continue
    const item = (event as { item?: unknown }).item
    if (isWireToolItem(item)) return item.title
  }
  return undefined
}
