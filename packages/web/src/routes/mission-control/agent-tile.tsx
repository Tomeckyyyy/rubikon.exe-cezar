import * as React from 'react'
import { Link } from 'react-router'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { StatusDot } from '@/components/status-dot'
import { tileStatusPaint } from '@/lib/mission-control'
import { formatCost } from '@/lib/tasks-table'
import { runTitle } from '@/lib/task-groups'
import { scopeTo } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * One run, as a tile — the shared unit the Grid lays out in a CSS grid and the Swarm Graph wraps
 * as a custom node's content (spec 2026-09-18-mission-control, "Architecture"). Rendered here as
 * a single component rather than two so the two views can never drift on what a run's card
 * actually shows.
 *
 * Deliberately presentational: it receives everything it paints (the joined project, the subtask
 * count, an optional live thumbnail) rather than reaching for a hook itself, so a `compact` node
 * in the graph and a full tile in the grid are the same component at two sizes, not two
 * components kept in sync by hand.
 */
export interface AgentTileProps {
  run: RunIndexEntry
  /** The joined registry entry, when the caller has the registry loaded — absent renders the
   *  bare project id rather than blocking the tile on a second fetch. */
  project?: ProjectListEntry
  /** Direct dispatched children (`lib/mission-control.ts`'s `subtaskCounts`). */
  subtaskCount?: number
  /** The last tool call observed on this run's own event stream (Phase 2) — absent when the run
   *  is not visible/`running`, or no per-run SSE has produced one yet. */
  thumbnail?: string
  /** The Swarm Graph's custom node uses the same tile at a smaller footprint. */
  compact?: boolean
  className?: string
  /** The one run the route currently has focused (`mission-control-route.tsx`'s
   *  `highlightedRunId`) — a ring rather than a background change, so it reads on top of the
   *  tile's own status color instead of fighting it. Survives a Grid⇄Graph switch because the
   *  route (not either view) owns the state. */
  highlighted?: boolean
  /** Fired on hover/focus, never on click — a tile's click is its navigation, and highlighting
   *  must not compete with that. This is what lets the route's `highlightedRunId` follow the
   *  pointer/keyboard without an extra control to operate. */
  onHighlight?: (runId: string) => void
}

/** `ref` forwards to the rendered `<a>` — `use-visible-run-events.ts`'s IntersectionObserver
 *  needs the real DOM node to know when a tile scrolls into view. React Router's `Link` already
 *  forwards its own ref to the anchor, so this is a plain pass-through, not a second mechanism. */
export const AgentTile = React.forwardRef<HTMLAnchorElement, AgentTileProps>(function AgentTile(
  { run, project, subtaskCount, thumbnail, compact = false, className, highlighted = false, onHighlight },
  ref,
) {
  const paint = tileStatusPaint(run)
  const title = runTitle(run)
  const cost = formatCost(run.costUsd)
  const to = scopeTo(run.projectId, `/tasks/${run.id}`)
  const highlight = onHighlight ? () => onHighlight(run.id) : undefined

  return (
    <Link
      ref={ref}
      to={to}
      data-slot="agent-tile"
      data-run-id={run.id}
      data-project={run.projectId}
      data-status={run.status}
      data-highlighted={highlighted || undefined}
      title={title}
      onMouseEnter={highlight}
      onFocus={highlight}
      className={cn(
        // A dozens-of-tiles-at-once board reads status by SCANNING, not reading — the reason this
        // tile carries a stronger status signal (a full-height edge, not just the dot the design
        // system otherwise reserves for that) than a Tasks row does. The bar sits in its own
        // absolutely-positioned span below so `overflow-hidden` can clip it to the tile's own
        // radius without a nested rounded corner of its own.
        'group relative isolate flex flex-col gap-1.5 overflow-hidden rounded-lg border border-border bg-card p-3 pl-3.5 shadow-xs transition-colors hover:bg-muted',
        compact && 'p-2 pl-2.5 gap-1',
        highlighted && 'ring-2 ring-violet ring-offset-1 ring-offset-background',
        className,
      )}
    >
      <span
        aria-hidden="true"
        data-slot="agent-tile-status-bar"
        className={cn(
          'absolute inset-y-0 left-0 w-[3px]',
          paint.tone === 'success' && 'bg-success',
          paint.tone === 'pending' && 'bg-pending',
          paint.tone === 'danger' && 'bg-danger',
          paint.tone === 'neutral' && 'bg-border',
          paint.pulse && (paint.slow ? 'motion-safe:animate-[pulse_3s_ease-in-out_infinite]' : 'motion-safe:animate-pulse'),
        )}
      />

      <span className="flex min-w-0 items-start gap-1.5">
        <StatusDot tone={paint.tone} pulse={paint.pulse} className="mt-[5px]" />
        <span
          className={cn(
            'min-w-0 flex-1 font-medium break-words',
            compact ? 'line-clamp-1 text-[11.5px]' : 'line-clamp-2 text-[13px] leading-[1.35]',
          )}
        >
          {title}
        </span>
        {subtaskCount ? (
          <span
            data-slot="agent-tile-subtasks"
            title={`${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}`}
            className="mt-px shrink-0 rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground"
          >
            {subtaskCount}
          </span>
        ) : null}
      </span>

      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-soft-foreground">
        <span className="truncate">{project?.name ?? run.projectId}</span>
        {compact ? null : (
          <>
            <span aria-hidden="true">&middot;</span>
            <span className="truncate">{run.workflow}</span>
          </>
        )}
      </span>

      {!compact && (cost || run.usage) ? (
        <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
          {cost ? <span data-slot="agent-tile-cost">{cost}</span> : null}
          {run.usage ? (
            <span data-slot="agent-tile-usage">
              {run.usage.cpuPct.toFixed(0)}% CPU
            </span>
          ) : null}
        </span>
      ) : null}

      {!compact && thumbnail ? (
        <span
          data-slot="agent-tile-thumbnail"
          className="truncate rounded bg-muted px-1.5 py-1 font-mono text-[10.5px] text-muted-foreground"
        >
          {thumbnail}
        </span>
      ) : null}
    </Link>
  )
})
