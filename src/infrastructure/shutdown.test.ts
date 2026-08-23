import { describe, expect, it, vi } from 'vitest'
import { shutdownProcess } from './shutdown.js'

describe('process shutdown', () => {
  it('attempts both clean-ups and exits when either rejects', async () => {
    const appError = new Error('app close failed')
    const closeApp = vi.fn(async () => { throw appError })
    const closeRuntime = vi.fn(async () => undefined)
    const onError = vi.fn()
    const exit = vi.fn()

    await shutdownProcess({
      reason: 'readiness_failure',
      timeoutMillis: 10_000,
      closeApp,
      closeRuntime,
      onClean: vi.fn(),
      onError,
      onTimeout: vi.fn(),
      exit,
    })

    expect(closeApp).toHaveBeenCalledOnce()
    expect(closeRuntime).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ errors: [appError] }))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits after a clean readiness-failure shutdown so Docker can restart it', async () => {
    const exit = vi.fn()

    await shutdownProcess({
      reason: 'readiness_failure',
      timeoutMillis: 10_000,
      closeApp: async () => undefined,
      closeRuntime: async () => undefined,
      onClean: vi.fn(),
      onError: vi.fn(),
      onTimeout: vi.fn(),
      exit,
    })

    expect(exit).toHaveBeenCalledWith(1)
  })

  it('keeps the forced-exit deadline armed while a clean-up is stuck', async () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    const shutdown = shutdownProcess({
      reason: 'readiness_failure',
      timeoutMillis: 10_000,
      closeApp: async () => { throw new Error('app close failed') },
      closeRuntime: () => new Promise<void>(() => undefined),
      onClean: vi.fn(),
      onError: vi.fn(),
      onTimeout: vi.fn(),
      exit,
    })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(exit).toHaveBeenCalledWith(1)
    void shutdown
    vi.useRealTimers()
  })
})
