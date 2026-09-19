import '@xyflow/react/dist/style.css'

import { Background, Controls, Handle, Position, ReactFlow, type Node, type NodeProps, type NodeTypes } from '@xyflow/react'
import { NetworkIcon } from 'lucide-react'
import * as React from 'react'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { CenteredState } from '@/components/centered-state'
import { useTheme } from '@/components/theme-provider'

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
  const { resolvedTheme } = useTheme()

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

  if (nodes.length === 0) {
    // Every run right now is either standalone or filtered out of `taskTreeToFlow` for having no
    // dispatch relationship at all (see that function's own header for why an isolated run is no
    // longer drawn as a node here) — a graph of zero dispatch trees is a correct, common state,
    // not an error, and saying so directly beats an empty canvas that just looks unfinished.
    return (
      <CenteredState
        heading="h2"
        icon={<NetworkIcon />}
        tone="neutral"
        title="No dispatch trees right now"
        subtitle="Swarm Graph only draws work that fanned out — a task that dispatched its own subtasks. Plain tasks show in Grid instead."
      />
    )
  }

  return (
    <div data-slot="mission-control-graph" className="h-[calc(100dvh-8rem)] min-h-[420px] w-full rounded-lg border border-border">
      <ReactFlow
        nodes={decoratedNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        // React Flow otherwise defaults to `colorMode="light"`, which stamps its own root div
        // with a `.light` class — and this codebase's OWN theme convention (`styles/index.css`)
        // reads `.light` globally, unscoped, to flip every `--card`/`--foreground` CSS variable
        // to the light palette. Left unset, that collision forces every tile inside the Swarm
        // Graph into light-theme colors regardless of the app's actual theme — `bg-card` and the
        // tile's (unset, inherited) text color both resolve to white, rendering the title
        // invisible. Wiring it to the app's own resolved theme is what keeps the two in sync.
        colorMode={resolvedTheme}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.25}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background gap={16} />
        {/* No MiniMap (spec, Architecture — unneeded at this scale); Controls alone is what makes
         *  pan/zoom discoverable instead of a mystery two-finger gesture on a canvas with no other
         *  affordance. `showInteractive={false}` drops the lock toggle — this graph is read-only
         *  already (`nodesDraggable`/`nodesConnectable` both false above), so the button would
         *  control a capability that does not exist. */}
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

/** A `NodeProps`-shaped wrapper so `AgentTile` (a plain component, shared with the Grid) can be
 *  react-flow's custom node content without knowing anything about react-flow itself.
 *
 * The two `Handle`s are load-bearing, not decoration: react-flow only auto-attaches connection
 * points to its OWN built-in node types (`default`/`input`/`output`) — a custom node type like
 * this one with none of its own draws no edges at all, silently (no console warning, an empty
 * `.react-flow__edges` SVG group). `opacity: 0` keeps them invisible (this graph is read-only —
 * `nodesConnectable={false}` on `<ReactFlow>` — so there is nothing to click) while still giving
 * every edge somewhere to anchor to. */
function AgentTileNode({ data }: NodeProps) {
  const { run, project, subtaskCount, highlighted, onHighlight } = data as DecoratedNodeData
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <AgentTile
        run={run}
        project={project}
        subtaskCount={subtaskCount}
        compact
        className="w-[236px]"
        highlighted={highlighted}
        onHighlight={onHighlight}
      />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </>
  )
}
