import { describe, expect, it } from 'vitest'
import { deterministicRows, normaliseExportRow } from './export-format.js'

describe('portable export normalisation', () => {
  it('canonicalises JSON strings and parsed PostgreSQL JSON to the same value', () => {
    const sqlite = normaliseExportRow('activity_events', {
      id: '00000000-0000-4000-8000-000000000002',
      payload_json: '{"z":1,"nested":{"b":2,"a":1}}',
    })
    const postgres = normaliseExportRow('activity_events', {
      id: '00000000-0000-4000-8000-000000000002',
      payload_json: { nested: { a: 1, b: 2 }, z: 1 },
    })

    expect(sqlite.payload_json).toBe('{"nested":{"a":1,"b":2},"z":1}')
    expect(sqlite).toEqual(postgres)
  })

  it('rejects invalid JSON in a declared JSON column', () => {
    expect(() => normaliseExportRow('activity_events', { payload_json: '{broken' }))
      .toThrow('activity_events.payload_json contains invalid JSON')
  })

  it('normalises Date objects and offset strings to the same UTC instant', () => {
    const sqlite = normaliseExportRow('projects', {
      deadline: '2026-07-11T10:00:00+02:00',
      created_at: '2026-07-11T08:00:00.000Z',
    })
    const postgres = normaliseExportRow('projects', {
      deadline: new Date('2026-07-11T08:00:00.000Z'),
      created_at: new Date('2026-07-11T08:00:00.000Z'),
    })

    expect(sqlite.deadline).toBe('2026-07-11T08:00:00.000Z')
    expect(sqlite).toEqual(postgres)
  })

  it('rejects invalid timestamps instead of producing incomparable exports', () => {
    expect(() => normaliseExportRow('projects', { created_at: 'not-a-timestamp' }))
      .toThrow('projects.created_at contains an invalid timestamp')
  })

  it('sorts normalised rows deterministically across backend representations', () => {
    const rows = deterministicRows('evidence', [
      { id: '00000000-0000-4000-8000-000000000002', ordinal: '2', stale: false, redaction_json: '{"fields":[],"count":0}', created_at: '2026-07-11T08:00:01Z' },
      { id: '00000000-0000-4000-8000-000000000001', ordinal: 1n, stale: 0, redaction_json: { count: 0, fields: [] }, created_at: new Date('2026-07-11T08:00:00Z') },
    ])

    expect(rows.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ])
    expect(rows[0]).toMatchObject({ ordinal: 1, stale: 0, created_at: '2026-07-11T08:00:00.000Z' })
  })
})
