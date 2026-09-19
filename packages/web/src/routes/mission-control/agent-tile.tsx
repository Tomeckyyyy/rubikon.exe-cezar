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
export function AgentTile({
  run,
  project,
  subtaskCount,
  thumbnail,
  compact = false,
  className,
}: {
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
}) {
  const paint = tileStatusPaint(run)
  const title = runTitle(run)
  const cost = formatCost(run.costUsd)
  const to = scopeTo(run.projectId, `/tasks/${run.id}`)

  return (
    <Link
      to={to}
      data-slot="agent-tile"
      data-run-id={run.id}
      data-project={run.projectId}
      data-status={run.status}
      title={title}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border bg-card p-3 shadow-xs transition-colors hover:bg-muted',
        paint.tone === 'success' && 'border-success/40',
        paint.tone === 'pending' && 'border-pending/40',
        paint.tone === 'danger' && 'border-danger/40',
        paint.tone === 'neutral' && 'border-border',
        paint.pulse && (paint.slow ? 'motion-safe:animate-[pulse_3s_ease-in-out_infinite]' : 'motion-safe:animate-pulse'),
        compact && 'p-2 gap-1',
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={paint.tone} pulse={paint.pulse} />
        <span className={cn('min-w-0 flex-1 truncate font-medium', compact ? 'text-[11.5px]' : 'text-[13px]')}>
          {title}
        </span>
        {subtaskCount ? (
          <span
            data-slot="agent-tile-subtasks"
            className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground"
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
}
