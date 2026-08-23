import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const compose = readFileSync(resolve(process.cwd(), 'compose.yaml'), 'utf8')
const istraService = compose.slice(compose.indexOf('\n  istra:'), compose.indexOf('\nvolumes:'))

describe('Docker Compose storage contract', () => {
  it('runs the application against the healthy internal PostgreSQL service', () => {
    expect(istraService).toContain('ISTRA_STORAGE: postgresql')
    expect(istraService).toContain('ISTRA_COMPOSE_DATABASE_URL')
    expect(istraService).toContain('@postgres:5432/')
    expect(istraService).toMatch(/depends_on:\n\s+postgres:\n\s+condition: service_healthy/)
    expect(istraService).toContain('ISTRA_READINESS_FAILURE_EXIT_THRESHOLD: "${ISTRA_READINESS_FAILURE_EXIT_THRESHOLD:-5}"')
    expect(istraService).toMatch(/healthcheck:[\s\S]+timeout: 5s/)
  })
})
