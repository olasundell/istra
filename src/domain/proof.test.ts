import { describe, expect, it } from 'vitest'
import { evaluateCriterionProof, explainRequirementProof } from './proof.js'

const observation = (id: string, result: 'recorded' | 'verified' | 'failed' | 'interrupted', createdAt: string, overrides: Record<string, unknown> = {}) => ({
  id, ordinal: Date.parse(createdAt), result, createdAt, stale: false, validationStatus: 'validated' as const, ...overrides,
})

describe('authoritative proof evaluation', () => {
  it('uses the latest current decisive evidence', () => {
    expect(evaluateCriterionProof({ id: 'criterion', title: 'Criterion', required: true, evidence: [
      observation('verified-first', 'verified', '2026-07-10T08:00:00.000Z'),
      observation('failed-later', 'failed', '2026-07-10T09:00:00.000Z'),
    ] })).toMatchObject({ status: 'defect', evidenceId: 'failed-later' })
    expect(evaluateCriterionProof({ id: 'criterion', title: 'Criterion', required: true, evidence: [
      observation('failed-first', 'failed', '2026-07-10T08:00:00.000Z'),
      observation('verified-later', 'verified', '2026-07-10T09:00:00.000Z'),
    ] })).toMatchObject({ status: 'proven', evidenceId: 'verified-later' })
  })

  it('ignores stale and legacy-unvalidated evidence', () => {
    expect(evaluateCriterionProof({ id: 'criterion', title: 'Criterion', required: true, evidence: [
      observation('stale', 'verified', '2026-07-10T09:00:00.000Z', { stale: true }),
      observation('legacy', 'verified', '2026-07-10T10:00:00.000Z', { validationStatus: 'legacy_unvalidated' }),
    ] })).toMatchObject({ status: 'open', evidenceId: null })
  })

  it('derives requirement proof from required criteria only', () => {
    const explanation = explainRequirementProof([
      { id: 'a', title: 'A', required: true, evidence: [], status: 'proven', evidenceId: 'e-a', reason: 'verified' },
      { id: 'b', title: 'B', required: true, evidence: [], status: 'partial', evidenceId: 'e-b', reason: 'recorded' },
      { id: 'optional', title: 'Optional', required: false, evidence: [], status: 'defect', evidenceId: 'e-c', reason: 'failed' },
    ])
    expect(explanation).toMatchObject({ status: 'partial', requiredCriteria: 2, provenCriteria: 1, partialCriteria: 1, defectiveCriteria: 0 })
  })
})
