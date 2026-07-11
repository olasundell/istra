import { describe, expect, it } from 'vitest'
import { readServerConfig } from './server-config.js'

describe('server configuration', () => {
  it('keeps native execution loopback-only by default', () => {
    expect(readServerConfig({})).toEqual({ host: '127.0.0.1', logLevel: 'info', port: 4317 })
  })

  it('accepts the explicit container listener and logging settings', () => {
    expect(readServerConfig({ ISTRA_HOST: '0.0.0.0', ISTRA_LOG_LEVEL: 'warn', PORT: '8080' }))
      .toEqual({ host: '0.0.0.0', logLevel: 'warn', port: 8080 })
  })

  it.each([
    [{ PORT: '0' }, 'PORT must be between 1 and 65535'],
    [{ PORT: 'abc' }, 'PORT must be an integer'],
    [{ ISTRA_HOST: '192.168.1.10' }, 'Invalid enum value'],
  ])('fails closed for invalid settings', (environment, message) => {
    expect(() => readServerConfig(environment)).toThrow(message)
  })
})
