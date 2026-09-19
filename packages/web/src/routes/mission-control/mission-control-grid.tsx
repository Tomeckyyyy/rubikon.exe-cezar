import { RadarIcon } from 'lucide-react'
import * as React from 'react'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { CenteredState } from '@/components/centered-state'
import { splitActiveRuns, subtaskCounts } from '@/lib/mission-control'
import { cn } from '@/lib/utils'

import { AgentTile } from './agent-tile'

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
  thumbnails,
}: {
  runs: readonly RunIndexEntry[]
  projects: readonly ProjectListEntry[]
  /** Phase 2: the last-tool-call thumbnail per visible, running run id. Absent (or an empty map)
   *  is a normal, complete state — no thumbnail is ever required to render a tile. */
  thumbnails?: ReadonlyMap<string, string>
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
        <Tiles runs={active} byId={byId} counts={counts} thumbnails={thumbnails} />
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
  thumbnails,
  className,
}: {
  runs: readonly RunIndexEntry[]
  byId: ReadonlyMap<string, ProjectListEntry>
  counts: ReadonlyMap<string, number>
  thumbnails?: ReadonlyMap<string, string>
  className?: string
}) {
  return (
    <div
      data-slot="mission-control-tiles"
      className={cn('grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3', className)}
    >
      {runs.map((run) => (
        <AgentTile
          key={`${run.projectId}/${run.id}`}
          run={run}
          project={byId.get(run.projectId)}
          subtaskCount={counts.get(run.id)}
          thumbnail={thumbnails?.get(run.id)}
        />
      ))}
    </div>
  )
}
