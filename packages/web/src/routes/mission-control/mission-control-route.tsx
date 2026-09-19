import { LayersIcon } from 'lucide-react'
import * as React from 'react'

import { useProjects, useRunsIndex } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { truncatedProjectNames } from '@/lib/global-tasks'

import { MissionControlGrid } from './mission-control-grid'

/** Same backstop interval `GlobalTasksRoute` polls the index on (see that file's own comment) —
 *  this page reads the identical query, so it inherits the same freshness story: the workspace
 *  SSE stream is the mechanism, this is the cover for a dropped socket or a frozen tab. */
const RUNS_INDEX_POLL_MS = 15_000

/**
 * `/mission-control` — a global (cross-project), purely front-end view of every run in flight,
 * as tiles (spec 2026-09-18-mission-control). Outside every `/p/:projectId`, exactly like
 * `/tasks`: reads the same workspace-level index (`useRunsIndex`) so it is never a second fetch
 * or a second cache for data `GlobalTasksRoute` already holds.
 *
 * Phase 1 renders only the Grid. The Grid⇄Swarm Graph toggle and its persisted mode
 * (`useWorkspaceUiState().missionControlView`) land in Phase 3.
 */
export function MissionControlRoute() {
  const projects = useProjects()
  const index = useRunsIndex(true, RUNS_INDEX_POLL_MS)
  const registry = React.useMemo(() => projects.data?.projects ?? [], [projects.data])
  const truncated = React.useMemo(
    () => truncatedProjectNames(index.data?.truncated ?? [], registry),
    [index.data, registry],
  )

  if (index.isError || projects.isError) {
    return (
      <div data-route="mission-control" className="flex min-h-full flex-col">
        <CenteredState
          icon={<LayersIcon />}
          tone="danger"
          title="Mission Control did not load"
          subtitle={(index.error ?? projects.error)?.message}
        />
      </div>
    )
  }

  return (
    <div data-route="mission-control" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Mission Control</h1>
        <div className="flex-1" />
        <span data-slot="mission-control-count" className="text-[12.5px] text-soft-foreground tabular-nums">
          {index.data?.runs.length ?? 0} runs
        </span>
      </header>

      <div className="flex flex-1 flex-col gap-3 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {truncated.length > 0 ? (
          <p data-slot="mission-control-truncated" className="text-[11.5px] text-soft-foreground">
            Showing the newest {index.data?.perProjectLimit} tasks per project — older ones in{' '}
            {truncated.join(', ')} are only in that project&rsquo;s own Tasks page.
          </p>
        ) : null}

        {index.data === undefined ? null : (
          <MissionControlGrid runs={index.data.runs} projects={registry} />
        )}
      </div>
    </div>
  )
}
