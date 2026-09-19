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
  /** Direct dispatched children — same number the Grid's tile badge shows (`lib/mission-control`'s
   *  `subtaskCounts`). Was missing entirely before this pass: the one view built to show dispatch
   *  hierarchy wasn't even printing "N subtasks" on its own nodes. */
  subtaskCount?: number
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
 * One tree → one connected dagre layout, positioned so multiple trees never overlap: each is
 * laid out independently and offset along X by the previous trees' width.
 *
 * A run with no dispatch relationship at all is DROPPED here, not drawn as its own isolated node
 * (a reversal of this module's original behavior — see git history / spec 2026-09-18-mission-
 * control for the earlier "islands" design). A single node with no edges tells a viewer nothing a
 * Grid tile doesn't already say better (cost, CPU, live thumbnail); at real usage scale, most
 * runs never dispatch, so drawing every one of them as a same-sized floating card just reproduces
 * the Grid with worse information density — the exact complaint that prompted this rewrite. The
 * Swarm Graph's only reason to exist is the SHAPE of dispatched work, so it now shows exactly
 * that and nothing else: when nothing has dispatched anything, `nodes` comes back empty and the
 * caller (`mission-control-graph.tsx`) renders a dedicated empty state instead of a canvas full of
 * disconnected cards.
 */
export function taskTreeToFlow(
  runs: readonly RunIndexEntry[],
): { nodes: MissionControlFlowNode[]; edges: MissionControlFlowEdge[] } {
  const trees = buildTaskTree(runs).filter((tree) => tree.descendantCount > 0)
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
      // Fan-out below THIS branch, not just whether it's in flight — a child that itself
      // dispatched nothing draws the thinnest line; one that fanned out to a handful of its own
      // subagents draws a visibly heavier one, so a glance at the tree shows where the actual
      // swarm is, not just a uniform set of same-weight lines. Capped so one enormous branch
      // cannot swallow the rest of the drawing.
      const weight = Math.min(child.descendantCount, 6)
      const strokeWidth = (animated ? 2 : 1.5) + weight * 0.4
      edges.push({
        id: `${node.run.id}->${child.run.id}`,
        source: node.run.id,
        target: child.run.id,
        animated,
        style: animated
          ? { stroke: 'var(--violet)', strokeWidth }
          : { stroke: 'var(--soft-foreground)', strokeWidth },
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
      data: { run: node.run, subtaskCount: node.childCount || undefined },
    }
  })

  return { nodes, edges }
}
