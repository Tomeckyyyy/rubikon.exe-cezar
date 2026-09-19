import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/components/theme-provider'
import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { MissionControlGraph } from './mission-control-graph'

/**
 * `task-tree-to-flow.test.ts` (a pure-function test) proves `taskTreeToFlow` COMPUTES the right
 * edges. It cannot prove react-flow actually DRAWS them: by default, react-flow only attaches
 * connection points to its own built-in node types, so a custom node type with no `<Handle>` of
 * its own draws no edges at all — silently (no console warning, no thrown error, just an empty
 * `.react-flow__edges` SVG group). That was a real bug here, found only by rendering the graph in
 * a real browser and looking at it; jsdom's lack of real layout (every element measures 0×0,
 * which is also what keeps `.react-flow__edge` elements from ever appearing in a jsdom render,
 * regardless of Handles) means this suite asserts the fix's actual mechanism — every node source
 * to give an edge somewhere to anchor to — is present, rather than the pixels an edge is not
 * rendered into. `om-auto-qa-pr`'s browser pass is the layer that verifies the picture.
 */

beforeEach(() => {
  // react-flow measures nodes with a ResizeObserver; jsdom has none. The bare stub, like every
  // other ResizeObserver-consuming test in this repo — this suite doesn't need it to fire, only
  // to exist so react-flow's own effect doesn't throw.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PROJECTS: ProjectListEntry[] = [
  {
    id: 'api',
    name: 'API',
    root: '/repos/api',
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
  },
]

function run(overrides: Partial<RunIndexEntry> & { id: string }): RunIndexEntry {
  return {
    projectId: 'api',
    title: overrides.id,
    status: 'running',
    createdAt: '2026-09-19T00:00:00.000Z',
    archived: false,
    workflow: 'quick-task',
    ...overrides,
  }
}

function renderGraph(runs: RunIndexEntry[]) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <MissionControlGraph runs={runs} projects={PROJECTS} />
      </ThemeProvider>
    </MemoryRouter>,
  )
}

describe('MissionControlGraph', () => {
  it('renders one DOM node per run', () => {
    const runs = [
      run({ id: 'root' }),
      run({ id: 'child-1', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } }),
      run({ id: 'standalone' }),
    ]
    const { container } = renderGraph(runs)
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(3)
  })

  it('gives every node a target AND a source handle — required for react-flow to draw an edge to/from a custom node type at all', () => {
    const runs = [
      run({ id: 'root' }),
      run({ id: 'child-1', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } }),
    ]
    const { container } = renderGraph(runs)
    const nodes = container.querySelectorAll('.react-flow__node')
    expect(nodes).toHaveLength(2)
    for (const node of nodes) {
      expect(node.querySelector('.react-flow__handle-top')).not.toBeNull()
      expect(node.querySelector('.react-flow__handle-bottom')).not.toBeNull()
    }
  })

  it('does not throw when nothing is dispatched (no edges to draw)', () => {
    const { container } = renderGraph([run({ id: 'solo' })])
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(1)
  })
})
