import dagre from 'dagre'

import type { RunIndexEntry } from '@open-mercato/cezar-api-client'

import { buildTaskTree, flattenTaskTree, type TaskTreeNode } from '@/lib/task-tree'

/**
 * The dispatch tree → react-flow's `{nodes, edges}` (spec 2026-09-18-mission-control, Phase 3).
 * Pure, and deliberately so: it renders nothing and touches no library beyond `dagre`'s layout
 * math, which is what makes it as unit-testable as `task-tree.ts` itself — see that module's own
 * header for why the nesting rule lives in exactly one place.
 *
 * `task-tree.ts` stays UNCHANGED (spec, Architecture): this is a second consumer of
 * `buildTaskTree`'s output, not a second nesting rule.
 */

/** react-flow node payload — the custom node component (`mission-control-graph.tsx`) reads
 *  `run` straight off this to render an `AgentTile`. */
export interface MissionControlFlowNodeData extends Record<string, unknown> {
  run: RunIndexEntry
}

export interface MissionControlFlowNode {
  id: string
  type: 'agentTile'
  position: { x: number; y: number }
  data: MissionControlFlowNodeData
}

export interface MissionControlFlowEdge {
  id: string
  source: string
  target: string
  /** `true` while the CHILD is still in flight — the spec's "animated for a still-running
   *  branch, static once it finished" rule. */
  animated: boolean
  /** React Flow's own default edge stroke reads as near-invisible against this app's dark
   *  background (its default theme assumes a white canvas) — CSS variables, not literal
   *  colors, so the edge repaints correctly if the viewer's theme is light. An in-flight
   *  branch gets the same violet the rest of the app reserves for "needs attention /
   *  in progress"; a settled one gets the quiet border-ish gray every other muted line uses. */
  style: { stroke: string; strokeWidth: number }
}

/** The tile footprint dagre lays out against — must match the actual rendered size closely
 *  enough that dagre's spacing looks intentional; exactness does not matter, since react-flow's
 *  own pan/zoom absorbs any small drift. */
const NODE_WIDTH = 236
const NODE_HEIGHT = 88
const RANK_SEP = 80
const NODE_SEP = 40

/** Whether an edge to this child should animate — the child's own status is what a dispatch
 *  BRANCH is "about": a `review` parent whose review already finished draws a static edge to it,
 *  even if the parent itself is still busy with something else. */
function isInFlight(run: Pick<RunIndexEntry, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running'
}

/**
 * One tree → one connected dagre layout, positioned so multiple trees (and standalone,
 * non-dispatched runs — spec UI/UX: "separate isolated nodes/islands on the same canvas") never
 * overlap: each is laid out independently and offset along X by the previous trees' width.
 */
export function taskTreeToFlow(
  runs: readonly RunIndexEntry[],
): { nodes: MissionControlFlowNode[]; edges: MissionControlFlowEdge[] } {
  const trees = buildTaskTree(runs)
  const nodes: MissionControlFlowNode[] = []
  const edges: MissionControlFlowEdge[] = []
  let xOffset = 0

  for (const tree of trees) {
    const layout = layoutOneTree(tree)
    let maxX = 0
    for (const node of layout.nodes) {
      node.position = { x: node.position.x + xOffset, y: node.position.y }
      maxX = Math.max(maxX, node.position.x)
      nodes.push(node)
    }
    edges.push(...layout.edges)
    xOffset = maxX + NODE_WIDTH + NODE_SEP * 2
  }

  return { nodes, edges }
}

function layoutOneTree(
  tree: TaskTreeNode<RunIndexEntry>,
): { nodes: MissionControlFlowNode[]; edges: MissionControlFlowEdge[] } {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'TB', nodesep: NODE_SEP, ranksep: RANK_SEP })
  graph.setDefaultEdgeLabel(() => ({}))

  const flat = flattenTaskTree([tree])
  for (const node of flat) {
    graph.setNode(node.run.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  const edges: MissionControlFlowEdge[] = []
  for (const node of flat) {
    for (const child of node.children) {
      graph.setEdge(node.run.id, child.run.id)
      const animated = isInFlight(child.run)
      edges.push({
        id: `${node.run.id}->${child.run.id}`,
        source: node.run.id,
        target: child.run.id,
        animated,
        style: animated
          ? { stroke: 'var(--violet)', strokeWidth: 2 }
          : { stroke: 'var(--soft-foreground)', strokeWidth: 1.5 },
      })
    }
  }

  dagre.layout(graph)

  const nodes: MissionControlFlowNode[] = flat.map((node) => {
    const position = graph.node(node.run.id) as { x: number; y: number }
    return {
      id: node.run.id,
      type: 'agentTile',
      // dagre centers nodes on `{x,y}`; react-flow positions from the top-left corner.
      position: { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 },
      data: { run: node.run },
    }
  })

  return { nodes, edges }
}
