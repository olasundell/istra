export interface ReadinessWatchdogOptions {
  failureThreshold: number
  intervalMillis: number
  onFailureThreshold(error: unknown, consecutiveFailures: number): void
}

export interface ReadinessWatchdog {
  poll(): Promise<void>
  start(): void
  stop(): void
}

export function createReadinessWatchdog(
  check: () => Promise<void>,
  options: ReadinessWatchdogOptions,
): ReadinessWatchdog {
  let consecutiveFailures = 0
  let inFlight = false
  let interval: NodeJS.Timeout | undefined
  let thresholdReported = false

  const poll = async () => {
    if (inFlight || thresholdReported || options.failureThreshold === 0) return
    inFlight = true
    try {
      await check()
      consecutiveFailures = 0
    } catch (error) {
      consecutiveFailures += 1
      if (
        options.failureThreshold > 0
        && consecutiveFailures >= options.failureThreshold
        && !thresholdReported
      ) {
        thresholdReported = true
        options.onFailureThreshold(error, consecutiveFailures)
      }
    } finally {
      inFlight = false
    }
  }

  return {
    poll,
    start() {
      if (interval || options.failureThreshold === 0) return
      interval = setInterval(() => void poll(), options.intervalMillis)
      interval.unref()
    },
    stop() {
      if (!interval) return
      clearInterval(interval)
      interval = undefined
    },
  }
}
