import '@xyflow/react/dist/style.css'

import { Background, ReactFlow, type Node, type NodeProps, type NodeTypes } from '@xyflow/react'
import * as React from 'react'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { AgentTile } from './agent-tile'
import { taskTreeToFlow, type MissionControlFlowNodeData } from './task-tree-to-flow'

/** What each node's `data` carries once the graph has joined in the registry and the route's
 *  highlight state — everything `AgentTileNode` needs, so it never reaches outside its own
 *  props for anything (react-flow re-renders a node from its `data`, not from ambient state). */
interface DecoratedNodeData extends MissionControlFlowNodeData {
  project?: ProjectListEntry
  highlighted: boolean
  onHighlight?: (runId: string) => void
}

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

  // Highlight/project join lives in each node's OWN `data`, not in `nodeTypes` — react-flow warns
  // (and, worse, actually remounts every custom node) when `nodeTypes` is a new object on every
  // render, which a naive `highlightedRunId` dependency would cause on every hover. Keeping
  // `nodeTypes` referentially stable and pushing what changes into `data` gets ordinary
  // re-renders instead of a remount storm each time the pointer moves.
  const decoratedNodes: Node<DecoratedNodeData>[] = React.useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          project: byId.get(node.data.run.projectId),
          highlighted: node.id === highlightedRunId,
          onHighlight: onHighlightRun,
        },
      })),
    [nodes, byId, highlightedRunId, onHighlightRun],
  )

  const nodeTypes = React.useMemo<NodeTypes>(() => ({ agentTile: AgentTileNode }), [])

  return (
    <div data-slot="mission-control-graph" className="h-[calc(100dvh-8rem)] min-h-[420px] w-full rounded-lg border border-border">
      <ReactFlow
        nodes={decoratedNodes}
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
function AgentTileNode({ data }: NodeProps) {
  const { run, project, highlighted, onHighlight } = data as DecoratedNodeData
  return (
    <AgentTile
      run={run}
      project={project}
      compact
      className="w-[220px]"
      highlighted={highlighted}
      onHighlight={onHighlight}
    />
  )
}
