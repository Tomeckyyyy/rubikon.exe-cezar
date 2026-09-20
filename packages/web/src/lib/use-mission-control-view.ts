import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import type { WorkspaceUiState } from '@open-mercato/cezar-api-client'

export type MissionControlView = 'grid' | 'graph'

const DEFAULT_VIEW: MissionControlView = 'grid'

/**
 * Mission Control's Grid⇄Swarm Graph toggle, persisted in `~/.cezar/ui-state.json`
 * (spec 2026-09-18-mission-control, Phase 3) — same optimistic-then-debounced-PUT shape
 * `useTaskTableColumns` established for `taskTable.expandedColumns`, simplified because
 * `missionControlView` is a plain top-level scalar rather than a nested bag to merge.
 *
 * The optimistic write lands in the shared query cache immediately (the toggle must feel
 * instant), and only the LATEST write's response is allowed to land back — an older PUT's
 * response arriving after a newer click has already moved on must not un-toggle the view.
 */
export function useMissionControlView(): {
  view: MissionControlView
  setView: (view: MissionControlView) => void
  isPending: boolean
} {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const sequence = React.useRef(0)
  const newestSequence = React.useRef(0)
  const writeChain = React.useRef<Promise<void>>(Promise.resolve())

  const view = uiState.data?.missionControlView ?? DEFAULT_VIEW

  const setView = React.useCallback(
    (nextView: MissionControlView) => {
      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      if (current === undefined) return
      if (current.missionControlView === nextView) return
      queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, {
        ...current,
        missionControlView: nextView,
      })

      const writeSequence = ++sequence.current
      newestSequence.current = writeSequence
      const write = writeChain.current.then(async () => {
        const merged = await putWorkspaceUiState({ missionControlView: nextView }, { keepalive: true })
        if (writeSequence === newestSequence.current) {
          queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, merged)
        }
      })
      writeChain.current = write.catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        if (writeSequence === newestSequence.current) {
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        }
      })
    },
    [queryClient],
  )

  return { view, setView, isPending: uiState.isPending }
}
