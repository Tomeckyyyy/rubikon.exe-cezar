import { RadarIcon } from 'lucide-react'
import * as React from 'react'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { CenteredState } from '@/components/centered-state'
import { splitActiveRuns, subtaskCounts } from '@/lib/mission-control'
import { cn } from '@/lib/utils'

import { AgentTile } from './agent-tile'
import { useVisibleRunEvents } from './use-visible-run-events'

/**
 * The Grid/Radar view (spec 2026-09-18-mission-control, "UI/UX → Grid/Radar"): a responsive tile
 * grid, active runs on top, finished ones collapsed into a default-hidden section.
 *
 * Presentational and self-contained: `mission-control-route.tsx` owns fetching (`useRunsIndex`)
 * and passes the resolved `RunIndexEntry[]`/registry down, so this component is just as testable
 * with plain fixtures as `TaskTable` in `global-tasks.tsx` is.
 */
export function MissionControlGrid({
  runs,
  projects,
}: {
  runs: readonly RunIndexEntry[]
  projects: readonly ProjectListEntry[]
}) {
  const byId = React.useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const { active, finished } = React.useMemo(() => splitActiveRuns(runs), [runs])
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
      <section data-slot="mission-control-active" aria-label="Active runs">
        {/* Only ACTIVE tiles ever observe their own visibility (Phase 2): a finished run is
            never `running`, so `useVisibleRunEvents` on one would just be an idle
            IntersectionObserver paying rent for nothing. */}
        <Tiles runs={active} byId={byId} counts={counts} observeVisibility />
      </section>

      {finished.length > 0 ? (
        <section data-slot="mission-control-finished">
          <button
            type="button"
            data-action="toggle-finished"
            aria-expanded={showFinished}
            onClick={() => setShowFinished((current) => !current)}
            className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase"
          >
            Recently finished
            <span className="font-mono text-[11px] font-medium tabular-nums">{finished.length}</span>
          </button>
          {showFinished ? <Tiles runs={finished} byId={byId} counts={counts} /> : null}
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
  className,
}: {
  runs: readonly RunIndexEntry[]
  byId: ReadonlyMap<string, ProjectListEntry>
  counts: ReadonlyMap<string, number>
  observeVisibility?: boolean
  className?: string
}) {
  return (
    <div
      data-slot="mission-control-tiles"
      className={cn('grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3', className)}
    >
      {runs.map((run) =>
        observeVisibility ? (
          <ObservedAgentTile
            key={`${run.projectId}/${run.id}`}
            run={run}
            project={byId.get(run.projectId)}
            subtaskCount={counts.get(run.id)}
          />
        ) : (
          <AgentTile
            key={`${run.projectId}/${run.id}`}
            run={run}
            project={byId.get(run.projectId)}
            subtaskCount={counts.get(run.id)}
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
}: {
  run: RunIndexEntry
  project?: ProjectListEntry
  subtaskCount?: number
}) {
  const { setNode, toolCall } = useVisibleRunEvents(run)
  return (
    <AgentTile
      ref={setNode}
      run={run}
      project={project}
      subtaskCount={subtaskCount}
      thumbnail={toolCall}
    />
  )
}
