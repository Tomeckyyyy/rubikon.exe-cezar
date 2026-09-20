import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HandoffBadge } from '@/components/handoff-badge'

beforeEach(() => {
  // Radix's tooltip measures its arrow with a ResizeObserver; jsdom has no layout observer.
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

const NOW = Date.parse('2026-09-20T12:00:00.000Z')
const badge = () => document.querySelector<HTMLElement>('[data-slot="handoff-badge"]')

describe('HandoffBadge', () => {
  it('renders "handed off" for an outbound task and says Continue is refused', () => {
    render(
      <HandoffBadge
        handoff={{ direction: 'out', at: '2026-09-19T12:00:00.000Z', peer: 'vps' }}
        now={NOW}
      />,
    )
    const el = badge()
    expect(el?.textContent).toBe('handed off')
    expect(el?.getAttribute('data-direction')).toBe('out')
    // The tooltip's sentence is also the accessible name — one string in the component, and the
    // assertion target here: Radix portals the tooltip content only while it is open, so the
    // accessible name is what a screen reader (and this test) can read while it is closed.
    const label = el?.getAttribute('aria-label') ?? ''
    expect(label).toContain('Continue refuses until it is unmarked')
    expect(label).toContain('to vps')
    expect(label).toContain('1d ago')
  })

  it('renders "imported" for an inbound task and names the journal-seeded Continue', () => {
    render(<HandoffBadge handoff={{ direction: 'in', at: '2026-09-19T12:00:00.000Z' }} now={NOW} />)
    const el = badge()
    expect(el?.textContent).toBe('imported')
    expect(el?.getAttribute('data-direction')).toBe('in')
    const label = el?.getAttribute('aria-label') ?? ''
    expect(label).toContain('Continue starts a fresh session from its handoff journal')
    expect(label).toContain('1d ago')
  })

  it('names the peer on an inbound task too', () => {
    render(
      <HandoffBadge
        handoff={{ direction: 'in', at: '2026-09-19T12:00:00.000Z', peer: 'laptop' }}
        now={NOW}
      />,
    )
    expect(badge()?.getAttribute('aria-label')).toContain('from laptop')
  })

  it('falls back to the raw timestamp when the age cannot be computed', () => {
    render(<HandoffBadge handoff={{ direction: 'out', at: 'not-a-date' }} now={NOW} />)
    expect(badge()?.getAttribute('aria-label')).toContain('not-a-date')
  })

  it('renders nothing when the run never travelled', () => {
    const { container } = render(<HandoffBadge handoff={undefined} />)
    expect(container.innerHTML).toBe('')
    expect(badge()).toBeNull()
  })
})
