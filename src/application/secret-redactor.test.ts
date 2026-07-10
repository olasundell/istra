import { describe, expect, it } from 'vitest'
import { SecretRedactor, redactSecrets } from './secret-redactor.js'

describe('SecretRedactor', () => {
  it('redacts environment assignments and shell flags while preserving their shape', () => {
    const result = redactSecrets(`TOKEN=alpha export API_KEY="beta value" AWS_SECRET_ACCESS_KEY=omega command --password gamma --client-secret='delta value'`)

    expect(result.value).toBe(`TOKEN=[REDACTED] export API_KEY="[REDACTED]" AWS_SECRET_ACCESS_KEY=[REDACTED] command --password [REDACTED] --client-secret='[REDACTED]'`)
    expect(result.count).toBe(5)
    expect(result.redactions).toEqual(expect.arrayContaining([
      { kind: 'environment', name: 'token', count: 1 },
      { kind: 'environment', name: 'api_key', count: 1 },
      { kind: 'shell-flag', name: 'password', count: 1 },
      { kind: 'shell-flag', name: 'client-secret', count: 1 },
    ]))
  })

  it('redacts authentication headers, cookies, URL userinfo and sensitive query parameters', () => {
    const input = [
      'Authorization: Bearer auth-secret',
      'Cookie: session=cookie-secret; theme=dark',
      'curl https://user:url-secret@example.test/path?access_token=query-secret&view=full',
    ].join('\n')

    const result = redactSecrets(input)

    expect(result.value).toContain('Authorization: [REDACTED]')
    expect(result.value).toContain('Cookie: [REDACTED]')
    expect(result.value).toContain('https://[REDACTED]@example.test/path?access_token=[REDACTED]&view=full')
    expect(result.value).not.toMatch(/auth-secret|cookie-secret|url-secret|query-secret/)
    expect(result.count).toBe(4)
  })

  it('redacts scalar and structured JSON values without exposing them in metadata', () => {
    const input = String.raw`{"password":"quoted \"secret\"","nested":{"apiKey":{"token":"inner-secret"}},"safe":"visible"}`
    const result = redactSecrets(input)

    expect(JSON.parse(result.value)).toEqual({
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]' },
      safe: 'visible',
    })
    expect(result.count).toBe(2)
    expect(JSON.stringify(result.redactions)).not.toMatch(/quoted|inner-secret/)
  })

  it('normalises configured project secret names across supported key styles', () => {
    const redactor = new SecretRedactor({
      secretNames: ['AURORA_IMPERIALIS_KEY'],
      replacement: '<hidden>',
    })
    const result = redactor.redact('AURORA_IMPERIALIS_KEY=env --aurora-imperialis-key flag https://example.test?auroraImperialisKey=query {"auroraImperialisKey":"json"}')

    expect(result.value).toBe('AURORA_IMPERIALIS_KEY=<hidden> --aurora-imperialis-key <hidden> https://example.test?auroraImperialisKey=<hidden> {"auroraImperialisKey":"<hidden>"}')
    expect(result.count).toBe(4)
    expect(new Set(result.redactions.map(({ kind }) => kind))).toEqual(new Set(['environment', 'shell-flag', 'query-parameter', 'json-key']))
  })

  it('leaves non-sensitive values unchanged and does not recount its own replacement', () => {
    const safe = 'MODE=debug --format json https://example.test?view=full {"title":"Visible"}'
    expect(redactSecrets(safe)).toEqual({ value: safe, redacted: false, count: 0, redactions: [] })

    const alreadyRedacted = 'TOKEN=[REDACTED] Authorization: [REDACTED]\n{"password":"[REDACTED]"}'
    expect(redactSecrets(alreadyRedacted)).toEqual({ value: alreadyRedacted, redacted: false, count: 0, redactions: [] })
  })

  it('can disable the default name list', () => {
    const result = redactSecrets('TOKEN=visible PROJECT_CREDENTIAL=hidden', {
      includeDefaultSecretNames: false,
      secretNames: ['PROJECT_CREDENTIAL'],
    })

    expect(result.value).toBe('TOKEN=visible PROJECT_CREDENTIAL=[REDACTED]')
    expect(result.count).toBe(1)
  })
})
