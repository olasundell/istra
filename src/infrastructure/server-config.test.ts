import { describe, expect, it } from 'vitest'
import { readServerConfig } from './server-config.js'

describe('server configuration', () => {
  it('keeps native execution loopback-only by default', () => {
    expect(readServerConfig({})).toEqual({ host: '127.0.0.1', logLevel: 'info', port: 4317, readinessFailureExitThreshold: 0 })
  })

  it('accepts the explicit container listener and logging settings', () => {
    expect(readServerConfig({ ISTRA_HOST: '0.0.0.0', ISTRA_LOG_LEVEL: 'warn', ISTRA_READINESS_FAILURE_EXIT_THRESHOLD: '5', PORT: '8080' }))
      .toEqual({ host: '0.0.0.0', logLevel: 'warn', port: 8080, readinessFailureExitThreshold: 5 })
  })

  it.each([
    [{ PORT: '0' }, 'PORT must be between 1 and 65535'],
    [{ PORT: 'abc' }, 'PORT must be an integer'],
    [{ ISTRA_HOST: '192.168.1.10' }, 'Invalid enum value'],
    [{ ISTRA_READINESS_FAILURE_EXIT_THRESHOLD: '101' }, 'must be between 0 and 100'],
    [{ ISTRA_READINESS_FAILURE_EXIT_THRESHOLD: '-1' }, 'must be an integer'],
  ])('fails closed for invalid settings', (environment, message) => {
    expect(() => readServerConfig(environment)).toThrow(message)
  })
})
