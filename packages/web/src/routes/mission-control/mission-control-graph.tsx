import '@xyflow/react/dist/style.css'

import { Background, ReactFlow, type NodeProps, type NodeTypes } from '@xyflow/react'
import * as React from 'react'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { AgentTile } from './agent-tile'
import { taskTreeToFlow, type MissionControlFlowNodeData } from './task-tree-to-flow'

/**
 * The Swarm Graph (spec 2026-09-18-mission-control, "UI/UX → Swarm Graph"): the dispatch tree,
 * animated. `@xyflow/react`, without `MiniMap` (spec, Architecture) — deliberately the one view
 * that pulls this dependency in, which is why it is its own module the route lazy-loads
 * separately from the Grid.
 *
 * The custom node type wraps the SAME `AgentTile` the Grid renders (`compact`), so the two views
 * can never drift on what a run's card says — see that component's own header.
 */
export function MissionControlGraph({
  runs,
  projects,
  highlightedRunId,
  onHighlightRun,
}: {
  runs: readonly RunIndexEntry[]
  projects: readonly ProjectListEntry[]
  highlightedRunId?: string
  onHighlightRun?: (runId: string) => void
}) {
  const byId = React.useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const { nodes, edges } = React.useMemo(() => taskTreeToFlow(runs), [runs])

  const nodeTypes = React.useMemo<NodeTypes>(
    () => ({
      agentTile: (props: NodeProps) => (
        <AgentTileNode
          {...props}
          project={byId.get((props.data as MissionControlFlowNodeData).run.projectId)}
          highlightedRunId={highlightedRunId}
          onHighlightRun={onHighlightRun}
        />
      ),
    }),
    [byId, highlightedRunId, onHighlightRun],
  )

  return (
    <div data-slot="mission-control-graph" className="h-[calc(100dvh-8rem)] min-h-[420px] w-full rounded-lg border border-border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background gap={16} />
      </ReactFlow>
    </div>
  )
}

/** A `NodeProps`-shaped wrapper so `AgentTile` (a plain component, shared with the Grid) can be
 *  react-flow's custom node content without knowing anything about react-flow itself. */
function AgentTileNode({
  data,
  project,
  highlightedRunId,
  onHighlightRun,
}: NodeProps & {
  project?: ProjectListEntry
  highlightedRunId?: string
  onHighlightRun?: (runId: string) => void
}) {
  const { run } = data as MissionControlFlowNodeData
  return (
    <AgentTile
      run={run}
      project={project}
      compact
      className="w-[220px]"
      highlighted={run.id === highlightedRunId}
      onHighlight={onHighlightRun}
    />
  )
}
