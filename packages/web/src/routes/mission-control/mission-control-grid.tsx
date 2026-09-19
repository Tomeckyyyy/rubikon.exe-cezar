import { ChevronDownIcon, RadarIcon } from 'lucide-react'
import * as React from 'react'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { CenteredState } from '@/components/centered-state'
import { sortByAge, splitActiveRuns, splitByAttention, subtaskCounts } from '@/lib/mission-control'
import { cn } from '@/lib/utils'

import { AgentTile } from './agent-tile'
import { useVisibleRunEvents } from './use-visible-run-events'

/**
 * The Grid/Radar view (spec 2026-09-18-mission-control, "UI/UX → Grid/Radar"): a responsive tile
 * grid, triaged the same way the sidebar quick-list triages a single project's tasks (`lib/task-
 * groups.ts`'s `bucketOf`) — "Needs you" (waiting/review) ahead of "Working" (running/queued),
 * finished runs collapsed into a default-hidden section. A board with dozens of tiles is only as
 * useful as the time it takes to answer "which of these is actually blocked on ME" — a flat
 * "Active" pile that gives a run quietly running and a run stuck on a question the same visual
 * weight makes the viewer do that triage by eye, tile by tile, which defeats the point of a
 * glanceable board.
 *
 * Presentational and self-contained: `mission-control-route.tsx` owns fetching (`useRunsIndex`)
 * and passes the resolved `RunIndexEntry[]`/registry down, so this component is just as testable
 * with plain fixtures as `TaskTable` in `global-tasks.tsx` is.
 */
export function MissionControlGrid({
  runs,
  projects,
  highlightedRunId,
  onHighlightRun,
}: {
  runs: readonly RunIndexEntry[]
  projects: readonly ProjectListEntry[]
  /** The route's currently focused run (Phase 3) — a ring around the matching tile, preserved
   *  across a Grid⇄Graph switch because the route, not this component, owns the state. */
  highlightedRunId?: string
  onHighlightRun?: (runId: string | undefined) => void
}) {
  const byId = React.useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const { active, finished } = React.useMemo(() => splitActiveRuns(runs), [runs])
  const { needsYou: needsYouRaw, working } = React.useMemo(() => splitByAttention(active), [active])
  // Oldest-first: the run that has been asking the longest is the one to open first (see
  // `sortByAge`'s own header) — the ONE place in this component that reorders rather than just
  // partitions, because it is the one place a raw "newest first" order actively misleads.
  const needsYou = React.useMemo(() => sortByAge(needsYouRaw), [needsYouRaw])
  const counts = React.useMemo(() => subtaskCounts(runs), [runs])
  const [showFinished, setShowFinished] = React.useState(false)

  if (runs.length === 0) {
    return (
      <CenteredState
        heading="h2"
        icon={<RadarIcon />}
        tone="neutral"
        title="No agents in action"
        subtitle="Start a task in any project and it shows up here."
      />
    )
  }

  return (
    <div data-slot="mission-control-grid" className="flex flex-col gap-4">
      {needsYou.length > 0 ? (
        <section data-slot="mission-control-needs-you" aria-label="Needs you">
          <p className="mb-2 text-[12px] font-semibold tracking-[0.04em] text-pending-strong uppercase">
            Needs you
          </p>
          <Tiles
            runs={needsYou}
            byId={byId}
            counts={counts}
            observeVisibility
            highlightedRunId={highlightedRunId}
            onHighlightRun={onHighlightRun}
          />
        </section>
      ) : null}

      {working.length > 0 ? (
        <section data-slot="mission-control-working" aria-label="Working">
          {(needsYou.length > 0 || finished.length > 0) ? (
            // Only shown once there's another section to distinguish it from — with nothing else
            // on the page, "Working" would be the sole heading and just adds noise.
            <p className="mb-2 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
              Working
            </p>
          ) : null}
          {/* Only ACTIVE tiles ever observe their own visibility (Phase 2): a finished run is
              never `running`, so `useVisibleRunEvents` on one would just be an idle
              IntersectionObserver paying rent for nothing. */}
          <Tiles
            runs={working}
            byId={byId}
            counts={counts}
            observeVisibility
            highlightedRunId={highlightedRunId}
            onHighlightRun={onHighlightRun}
          />
        </section>
      ) : null}

      {finished.length > 0 ? (
        <section data-slot="mission-control-finished">
          <button
            type="button"
            data-action="toggle-finished"
            aria-expanded={showFinished}
            onClick={() => setShowFinished((current) => !current)}
            // Same disclosure convention as `agents-dock.tsx`'s header (chevron, rotate on
            // collapse) — this one was text-only, which is why it read as a label rather than a
            // control: nothing about it looked pressable.
            className="group -mx-1.5 mb-2 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase hover:bg-muted hover:text-foreground"
          >
            <ChevronDownIcon
              aria-hidden
              className={cn('size-3.5 shrink-0 transition-transform', !showFinished && '-rotate-90')}
            />
            Recently finished
            <span className="font-mono text-[11px] font-medium tabular-nums">{finished.length}</span>
          </button>
          {showFinished ? (
            <Tiles
              runs={finished}
              byId={byId}
              counts={counts}
              highlightedRunId={highlightedRunId}
              onHighlightRun={onHighlightRun}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

function Tiles({
  runs,
  byId,
  counts,
  observeVisibility = false,
  highlightedRunId,
  onHighlightRun,
  className,
}: {
  runs: readonly RunIndexEntry[]
  byId: ReadonlyMap<string, ProjectListEntry>
  counts: ReadonlyMap<string, number>
  observeVisibility?: boolean
  highlightedRunId?: string
  onHighlightRun?: (runId: string | undefined) => void
  className?: string
}) {
  return (
    <div
      data-slot="mission-control-tiles"
      className={cn('grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3', className)}
    >
      {runs.map((run) =>
        observeVisibility ? (
          <ObservedAgentTile
            key={`${run.projectId}/${run.id}`}
            run={run}
            project={byId.get(run.projectId)}
            subtaskCount={counts.get(run.id)}
            highlighted={run.id === highlightedRunId}
            onHighlight={onHighlightRun}
          />
        ) : (
          <AgentTile
            key={`${run.projectId}/${run.id}`}
            run={run}
            project={byId.get(run.projectId)}
            subtaskCount={counts.get(run.id)}
            highlighted={run.id === highlightedRunId}
            onHighlight={onHighlightRun}
          />
        ),
      )}
    </div>
  )
}

/**
 * One active tile, wired to its own visibility-conditional per-run stream (Phase 2). Kept as its
 * own component rather than inlined in `Tiles`' map: `useVisibleRunEvents` is a HOOK, and calling
 * one conditionally per array element is exactly the "hooks in a loop" mistake React's rules
 * exist to catch — a separate component per row is what makes the per-row subscription legal.
 */
function ObservedAgentTile({
  run,
  project,
  subtaskCount,
  highlighted,
  onHighlight,
}: {
  run: RunIndexEntry
  project?: ProjectListEntry
  subtaskCount?: number
  highlighted?: boolean
  onHighlight?: (runId: string | undefined) => void
}) {
  const { setNode, toolCall } = useVisibleRunEvents(run)
  return (
    <AgentTile
      ref={setNode}
      run={run}
      project={project}
      subtaskCount={subtaskCount}
      thumbnail={toolCall}
      highlighted={highlighted}
      onHighlight={onHighlight}
    />
  )
}
