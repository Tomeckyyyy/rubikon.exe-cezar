import type { RunEvent, RunIndexEntry, RunStatus } from '@open-mercato/cezar-api-client'

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
 * Grid's "active" section and its default-collapsed "recently finished" one. A stable partition,
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

/** One tile's status paint: the dot tone, whether it pulses, and — for `running` vs `queued`,
 *  which both pulse — whether that pulse should read SLOWER, so a queued tile does not compete
 *  with a running one for attention. */
export interface TileStatusPaint {
  tone: StatusDotTone
  pulse: boolean
  /** Only meaningful when `pulse` is true. */
  slow: boolean
  label: string
}

/**
 * Status → tile paint, straight off `RunIndexEntry.status` (spec UI/UX → Grid/Radar): a pulsing
 * border for `running`, a slower pulse for `queued`, an amber ("pending") accent for
 * `waiting`/`review`, static for every terminal state. Deliberately simpler than
 * `lib/attention.ts`'s `deriveAttention` (which layers in permission prompts and auto-resume
 * scheduling for the Tasks table's "needs you" language) — a tile names the RAW run status, not
 * an attention verdict, so a glance at fifty tiles reads as "what state is each one actually in".
 */
export function tileStatusPaint(run: Pick<RunIndexEntry, 'status'>): TileStatusPaint {
  switch (run.status) {
    case 'running':
      return { tone: 'success', pulse: true, slow: false, label: 'running' }
    case 'queued':
      return { tone: 'pending', pulse: true, slow: true, label: 'queued' }
    case 'waiting':
      return { tone: 'pending', pulse: true, slow: false, label: 'needs you' }
    case 'review':
      return { tone: 'pending', pulse: true, slow: false, label: 'needs review' }
    case 'failed':
      return { tone: 'danger', pulse: false, slow: false, label: 'failed' }
    case 'cancelled':
      return { tone: 'neutral', pulse: false, slow: false, label: 'cancelled' }
    case 'done':
    default:
      return { tone: 'neutral', pulse: false, slow: false, label: 'done' }
  }
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
