import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkflowStatsGroup } from '@/lib/workflow-stats'
import { WorkflowStatsRow } from '@/components/workflow-stats-row'

afterEach(cleanup)

function group(overrides: Partial<WorkflowStatsGroup> = {}): WorkflowStatsGroup {
  return {
    workflow: 'quick-task',
    runner: 'claude',
    model: 'sonnet',
    counts: { queued: 0, running: 0, waiting: 0, review: 0, done: 0, failed: 0, cancelled: 0 },
    terminalTotal: 0,
    failedRate: undefined,
    avgDurationMs: undefined,
    avgTokens: undefined,
    avgCostUsd: undefined,
    ...overrides,
  }
}

describe('WorkflowStatsRow', () => {
  it('renders nothing when there are no groups', () => {
    const { container } = render(<WorkflowStatsRow groups={[]} usage={{ tokens: true, cost: true }} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the runner/model label and the outcome counts', () => {
    render(
      <WorkflowStatsRow
        groups={[
          group({
            terminalTotal: 12,
            counts: { queued: 0, running: 0, waiting: 0, review: 4, done: 5, failed: 2, cancelled: 1 },
          }),
        ]}
        usage={{ tokens: true, cost: true }}
      />,
    )
    const row = screen.getByTestId('workflow-stats-row').querySelector('[data-slot="workflow-stats-group"]')!
    expect(row.textContent).toContain('claude/sonnet')
    expect(row.textContent).toContain('12')
    expect(row.textContent).toContain('9') // done + review
    expect(row.textContent).toContain('2')
    expect(row.textContent).toContain('1')
  })

  it('does not mark the failed count as danger below the sample-size threshold', () => {
    render(
      <WorkflowStatsRow
        groups={[group({ terminalTotal: 1, counts: { queued: 0, running: 0, waiting: 0, review: 0, done: 0, failed: 1, cancelled: 0 }, failedRate: 1 })]}
        usage={{ tokens: true, cost: true }}
      />,
    )
    const failedStat = screen.getByTestId('workflow-stats-row').querySelector('[data-slot="stat-failed"]')!
    expect(failedStat.getAttribute('data-danger')).toBe('false')
  })

  it('marks the failed count as danger at or above the sample-size threshold when any run failed', () => {
    render(
      <WorkflowStatsRow
        groups={[group({ terminalTotal: 3, counts: { queued: 0, running: 0, waiting: 0, review: 0, done: 2, failed: 1, cancelled: 0 }, failedRate: 1 / 3 })]}
        usage={{ tokens: true, cost: true }}
      />,
    )
    const failedStat = screen.getByTestId('workflow-stats-row').querySelector('[data-slot="stat-failed"]')!
    expect(failedStat.getAttribute('data-danger')).toBe('true')
  })

  it('hides cost and token stats when the usage capability says so', () => {
    render(
      <WorkflowStatsRow
        groups={[group({ terminalTotal: 3, avgCostUsd: 0.38, avgTokens: 4200 })]}
        usage={{ tokens: false, cost: false }}
      />,
    )
    const el = screen.getByTestId('workflow-stats-row')
    expect(el.querySelector('[data-slot="stat-cost"]')).toBeNull()
    expect(el.querySelector('[data-slot="stat-tokens"]')).toBeNull()
  })

  it('shows cost and token stats when visible and present', () => {
    render(
      <WorkflowStatsRow
        groups={[group({ terminalTotal: 3, avgCostUsd: 0.38, avgTokens: 4200 })]}
        usage={{ tokens: true, cost: true }}
      />,
    )
    const el = screen.getByTestId('workflow-stats-row')
    expect(el.querySelector('[data-slot="stat-cost"]')?.textContent).toContain('$0.38')
    expect(el.querySelector('[data-slot="stat-tokens"]')?.textContent).toContain('4.2k')
  })

  it('omits the duration stat when no terminal run has both timestamps', () => {
    render(<WorkflowStatsRow groups={[group({ terminalTotal: 3, avgDurationMs: undefined })]} usage={{ tokens: true, cost: true }} />)
    expect(screen.getByTestId('workflow-stats-row').querySelector('[data-slot="stat-duration"]')).toBeNull()
  })
})
