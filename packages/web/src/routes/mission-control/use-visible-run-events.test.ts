import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVisibleRunEvents } from './use-visible-run-events'

/**
 * jsdom ships no `IntersectionObserver` either (same doctrine as `run-events.test.ts`'s
 * `FakeEventSource`): the stub implements only what the hook touches, plus the one lever the
 * hook cannot pull itself — reporting an intersection change on demand.
 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  observed: Element[] = []
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
  }

  /** Fire a fake intersection change on the given (or first observed) element. */
  fire(isIntersecting: boolean, target: Element = this.observed[0]!): void {
    act(() => {
      this.callback(
        [{ isIntersecting, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    })
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(name: string, fn: (event: Event) => void): void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(fn)
    this.listeners.set(name, set)
  }
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2
  }
}

const node = () => document.createElement('div')

beforeEach(() => {
  FakeIntersectionObserver.instances = []
  FakeEventSource.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useVisibleRunEvents', () => {
  it('does not subscribe before the node is visible', () => {
    const { result } = renderHook(() =>
      useVisibleRunEvents({ id: 'run-1', projectId: 'proj-a', status: 'running' }),
    )
    act(() => result.current.setNode(node()))
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('subscribes once the tile is visible and running, via the explicit-project stream', () => {
    const { result } = renderHook(() =>
      useVisibleRunEvents({ id: 'run-1', projectId: 'proj-a', status: 'running' }),
    )
    act(() => result.current.setNode(node()))
    FakeIntersectionObserver.instances[0]!.fire(true)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]!.url).toBe('/api/v1/p/proj-a/runs/run-1/events')
  })

  it('unsubscribes when the tile scrolls out of view', () => {
    const { result } = renderHook(() =>
      useVisibleRunEvents({ id: 'run-1', projectId: 'proj-a', status: 'running' }),
    )
    act(() => result.current.setNode(node()))
    FakeIntersectionObserver.instances[0]!.fire(true)
    expect(FakeEventSource.instances[0]!.readyState).toBe(0)
    FakeIntersectionObserver.instances[0]!.fire(false)
    expect(FakeEventSource.instances[0]!.readyState).toBe(2)
  })

  it('unsubscribes when the run stops being `running`, even while still visible', () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: 'running' | 'done' }) =>
        useVisibleRunEvents({ id: 'run-1', projectId: 'proj-a', status }),
      { initialProps: { status: 'running' } },
    )
    act(() => result.current.setNode(node()))
    FakeIntersectionObserver.instances[0]!.fire(true)
    expect(FakeEventSource.instances[0]!.readyState).toBe(0)
    rerender({ status: 'done' })
    expect(FakeEventSource.instances[0]!.readyState).toBe(2)
  })

  it('disconnects its observer on unmount, leaking neither a socket nor an observer', () => {
    const { result, unmount } = renderHook(() =>
      useVisibleRunEvents({ id: 'run-1', projectId: 'proj-a', status: 'running' }),
    )
    act(() => result.current.setNode(node()))
    FakeIntersectionObserver.instances[0]!.fire(true)
    unmount()
    expect(FakeIntersectionObserver.instances[0]!.disconnected).toBe(true)
    expect(FakeEventSource.instances[0]!.readyState).toBe(2)
  })

  it('disconnects the previous observer when the observed node changes', () => {
    const { result } = renderHook(() =>
      useVisibleRunEvents({ id: 'run-1', projectId: 'proj-a', status: 'running' }),
    )
    act(() => result.current.setNode(node()))
    const first = FakeIntersectionObserver.instances[0]!
    act(() => result.current.setNode(node()))
    expect(first.disconnected).toBe(true)
    expect(FakeIntersectionObserver.instances).toHaveLength(2)
  })
})
