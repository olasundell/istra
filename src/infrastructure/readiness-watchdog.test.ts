import { describe, expect, it, vi } from 'vitest'
import { createReadinessWatchdog } from './readiness-watchdog.js'

describe('readiness watchdog', () => {
  it('reports the configured consecutive failure threshold once', async () => {
    const error = new Error('PostgreSQL is not ready')
    const check = vi.fn(async () => { throw error })
    const onFailureThreshold = vi.fn()
    const watchdog = createReadinessWatchdog(check, {
      failureThreshold: 3,
      intervalMillis: 10_000,
      onFailureThreshold,
    })

    await watchdog.poll()
    await watchdog.poll()
    expect(onFailureThreshold).not.toHaveBeenCalled()
    await watchdog.poll()
    await watchdog.poll()

    expect(onFailureThreshold).toHaveBeenCalledOnce()
    expect(onFailureThreshold).toHaveBeenCalledWith(error, 3)
  })

  it('requires failures to be consecutive', async () => {
    const check = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'))
    const onFailureThreshold = vi.fn()
    const watchdog = createReadinessWatchdog(check, {
      failureThreshold: 2,
      intervalMillis: 10_000,
      onFailureThreshold,
    })

    await watchdog.poll()
    await watchdog.poll()
    await watchdog.poll()
    expect(onFailureThreshold).not.toHaveBeenCalled()
    await watchdog.poll()

    expect(onFailureThreshold).toHaveBeenCalledOnce()
  })

  it('can leave fail-fast recovery disabled for native runtimes', async () => {
    const onFailureThreshold = vi.fn()
    const check = vi.fn(async () => { throw new Error('unavailable') })
    const watchdog = createReadinessWatchdog(
      check,
      { failureThreshold: 0, intervalMillis: 10_000, onFailureThreshold },
    )

    await watchdog.poll()
    watchdog.start()
    expect(check).not.toHaveBeenCalled()
    expect(onFailureThreshold).not.toHaveBeenCalled()
  })

  it('coalesces overlapping polls into one database check', async () => {
    let releaseCheck: (() => void) | undefined
    const check = vi.fn(() => new Promise<void>((resolve) => { releaseCheck = resolve }))
    const onFailureThreshold = vi.fn()
    const watchdog = createReadinessWatchdog(
      check,
      { failureThreshold: 2, intervalMillis: 10_000, onFailureThreshold },
    )

    const first = watchdog.poll()
    const overlapping = watchdog.poll()
    expect(check).toHaveBeenCalledOnce()
    await overlapping
    releaseCheck?.()
    await first
    expect(onFailureThreshold).not.toHaveBeenCalled()
  })

  it('paces checks independently of public readiness requests', async () => {
    vi.useFakeTimers()
    const check = vi.fn(async () => { throw new Error('unavailable') })
    const onFailureThreshold = vi.fn()
    const watchdog = createReadinessWatchdog(
      check,
      { failureThreshold: 2, intervalMillis: 10_000, onFailureThreshold },
    )

    watchdog.start()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onFailureThreshold).toHaveBeenCalledOnce()
    watchdog.stop()
    vi.useRealTimers()
  })
})
