export type ShutdownReason = NodeJS.Signals | 'readiness_failure'

export interface ProcessShutdownOptions {
  reason: ShutdownReason
  timeoutMillis: number
  closeApp(): Promise<void>
  closeRuntime(): Promise<void>
  onClean(): void
  onError(error: AggregateError): void
  onTimeout(): void
  exit(code: number): void
}

export async function shutdownProcess(options: ProcessShutdownOptions): Promise<void> {
  const deadline = setTimeout(() => {
    options.onTimeout()
    options.exit(1)
  }, options.timeoutMillis)
  deadline.unref()

  const errors: unknown[] = []
  try {
    await options.closeApp()
  } catch (error) {
    errors.push(error)
  }
  try {
    await options.closeRuntime()
  } catch (error) {
    errors.push(error)
  }

  if (errors.length > 0) {
    options.onError(new AggregateError(errors, 'Failed to shut down Istra cleanly'))
    clearTimeout(deadline)
    options.exit(1)
    return
  }

  clearTimeout(deadline)
  options.onClean()
  if (options.reason === 'readiness_failure') options.exit(1)
}
