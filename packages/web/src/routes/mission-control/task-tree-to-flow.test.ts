import { describe, expect, it } from 'vitest'

import type { RunIndexEntry } from '@open-mercato/cezar-api-client'

import { taskTreeToFlow } from './task-tree-to-flow'

function run(overrides: Partial<RunIndexEntry> & { id: string }): RunIndexEntry {
  return {
    projectId: 'proj-1',
    title: overrides.id,
    status: 'running',
    createdAt: '2026-09-19T00:00:00.000Z',
    archived: false,
    workflow: 'quick-task',
    ...overrides,
  }
}

describe('taskTreeToFlow', () => {
  it('produces one node per run and one edge per dispatch relation', () => {
    const runs = [
      run({ id: 'root', status: 'running' }),
      run({ id: 'child-1', status: 'running', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } }),
      run({ id: 'child-2', status: 'done', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'review' } }),
    ]
    const { nodes, edges } = taskTreeToFlow(runs)
    expect(nodes.map((n) => n.id).sort()).toEqual(['child-1', 'child-2', 'root'])
    expect(edges).toHaveLength(2)
    expect(edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(['root->child-1', 'root->child-2'])
  })

  it('drops a standalone (non-dispatched) run entirely — a lone node with no edge repeats the Grid, not the dispatch shape this view exists to show', () => {
    const runs = [
      run({ id: 'dispatcher' }),
      run({ id: 'dispatcher-child', dispatch: { rootRunId: 'dispatcher', parentRunId: 'dispatcher', kind: 'implement' } }),
      run({ id: 'standalone' }),
    ]
    const { nodes } = taskTreeToFlow(runs)
    expect(nodes.map((n) => n.id).sort()).toEqual(['dispatcher', 'dispatcher-child'])
  })

  it('comes back empty when nothing in the list has dispatched anything', () => {
    const runs = [run({ id: 'a' }), run({ id: 'b' }), run({ id: 'c' })]
    const { nodes, edges } = taskTreeToFlow(runs)
    expect(nodes).toHaveLength(0)
    expect(edges).toHaveLength(0)
  })

  it('draws a heavier edge under a branch that fanned out to more of its own subtasks', () => {
    const runs = [
      run({ id: 'root' }),
      run({ id: 'light-child', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } }),
      run({ id: 'heavy-child', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } }),
      run({ id: 'grandchild-1', dispatch: { rootRunId: 'root', parentRunId: 'heavy-child', kind: 'implement' } }),
      run({ id: 'grandchild-2', dispatch: { rootRunId: 'root', parentRunId: 'heavy-child', kind: 'implement' } }),
    ]
    const { edges } = taskTreeToFlow(runs)
    const byTarget = new Map(edges.map((e) => [e.target, e]))
    expect(byTarget.get('heavy-child')!.style.strokeWidth).toBeGreaterThan(
      byTarget.get('light-child')!.style.strokeWidth,
    )
  })

  it("carries each node's own direct-child count for the tile's subtask badge", () => {
    const runs = [
      run({ id: 'root' }),
      run({ id: 'child-1', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } }),
      run({ id: 'child-2', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'review' } }),
    ]
    const { nodes } = taskTreeToFlow(runs)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect(byId.get('root')!.data.subtaskCount).toBe(2)
    expect(byId.get('child-1')!.data.subtaskCount).toBeUndefined()
  })

  it('never overlaps two separate trees on the canvas', () => {
    const runs = [
      run({ id: 'tree-a-root' }),
      run({ id: 'tree-a-child', dispatch: { rootRunId: 'tree-a-root', parentRunId: 'tree-a-root', kind: 'implement' } }),
      run({ id: 'tree-b-root' }),
      run({ id: 'tree-b-child', dispatch: { rootRunId: 'tree-b-root', parentRunId: 'tree-b-root', kind: 'implement' } }),
    ]
    const { nodes } = taskTreeToFlow(runs)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    // Distinct trees are offset far enough apart that their bounding boxes cannot overlap —
    // exact numbers are an implementation detail; "clearly separated" is the invariant.
    expect(byId.get('tree-b-root')!.position.x).toBeGreaterThan(byId.get('tree-a-root')!.position.x + 100)
  })

  it('animates an edge only while its CHILD is still in flight', () => {
    const runs = [
      run({ id: 'root', status: 'done' }),
      run({ id: 'running-child', status: 'running', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } }),
      run({ id: 'done-child', status: 'done', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'review' } }),
    ]
    const { edges } = taskTreeToFlow(runs)
    const byTarget = new Map(edges.map((e) => [e.target, e]))
    expect(byTarget.get('running-child')!.animated).toBe(true)
    expect(byTarget.get('done-child')!.animated).toBe(false)
    // A different stroke too — an in-flight branch and a settled one must not read as the same
    // line at a glance (react-flow's default stroke is near-invisible on this app's dark
    // background; found by actually rendering the graph in a browser).
    expect(byTarget.get('running-child')!.style.stroke).not.toBe(byTarget.get('done-child')!.style.stroke)
  })

  it('carries the whole run on each node for the custom node renderer', () => {
    const runs = [
      run({ id: 'root', title: 'Root task' }),
      run({ id: 'child', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } }),
    ]
    const { nodes } = taskTreeToFlow(runs)
    const root = nodes.find((n) => n.id === 'root')!
    expect(root.data.run.id).toBe('root')
    expect(root.type).toBe('agentTile')
  })
})
