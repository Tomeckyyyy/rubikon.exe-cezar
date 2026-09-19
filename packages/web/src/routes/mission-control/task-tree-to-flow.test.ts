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

  it('never drops a standalone (non-dispatched) run — it becomes its own isolated node', () => {
    const runs = [run({ id: 'root' }), run({ id: 'standalone' })]
    const { nodes, edges } = taskTreeToFlow(runs)
    expect(nodes.map((n) => n.id).sort()).toEqual(['root', 'standalone'])
    expect(edges).toHaveLength(0)
  })

  it('never overlaps two separate trees on the canvas', () => {
    const runs = [
      run({ id: 'tree-a-root' }),
      run({ id: 'tree-a-child', dispatch: { rootRunId: 'tree-a-root', parentRunId: 'tree-a-root', kind: 'implement' } }),
      run({ id: 'tree-b-root' }),
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
    const runs = [run({ id: 'root', title: 'Root task' })]
    const { nodes } = taskTreeToFlow(runs)
    expect(nodes[0]!.data.run.id).toBe('root')
    expect(nodes[0]!.type).toBe('agentTile')
  })
})
