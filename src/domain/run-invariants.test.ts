import { describe, expect, it } from 'vitest'
import {
  RunEvidenceInvariantError,
  assertEvidenceInvariants,
  assertRunInvariants,
  validateEvidenceInvariants,
  validateRunInvariants,
  type RunInvariantInput,
} from './run-invariants.js'

const completeRun = (overrides: Partial<RunInvariantInput> = {}): RunInvariantInput => ({
  startedAt: '2026-07-10T08:00:00.000Z',
  endedAt: '2026-07-10T08:01:00.000Z',
  outcome: 'recorded',
  ...overrides,
})

const codes = (run: RunInvariantInput) => validateRunInvariants(run).map(({ code }) => code)

describe('run invariants', () => {
  it('accepts equal or increasing run timestamps and rejects reversed or invalid timestamps', () => {
    expect(codes(completeRun({ endedAt: '2026-07-10T08:00:00.000Z' }))).toEqual([])
    expect(codes(completeRun({ endedAt: '2026-07-10T07:59:59.000Z' }))).toContain('RUN_END_BEFORE_START')
    expect(codes(completeRun({ startedAt: 'not-a-date' }))).toContain('RUN_STARTED_AT_INVALID')
    expect(codes(completeRun({ endedAt: 'not-a-date' }))).toContain('RUN_ENDED_AT_INVALID')
  })

  it('requires exact test totals', () => {
    expect(codes(completeRun({ testSummary: { passed: 2, failed: 1, skipped: 1, targetCount: 4 } }))).toEqual([])
    expect(codes(completeRun({ testSummary: { passed: 2, failed: 1, skipped: 1, targetCount: 5 } }))).toContain('TEST_TOTAL_MISMATCH')
  })

  it('accepts only complete verified runs with a positive success signal', () => {
    expect(codes(completeRun({ outcome: 'verified', exitCode: 0 }))).toEqual([])
    expect(codes(completeRun({
      outcome: 'verified',
      testSummary: { passed: 3, failed: 0, skipped: 0, targetCount: 3 },
    }))).toEqual([])

    expect(codes(completeRun({ outcome: 'verified', endedAt: null, exitCode: 0 }))).toContain('VERIFIED_RUN_INCOMPLETE')
    expect(codes(completeRun({ outcome: 'verified', exitCode: 1 }))).toEqual(expect.arrayContaining([
      'VERIFIED_RUN_NONZERO_EXIT',
      'VERIFIED_RUN_SUCCESS_SIGNAL_REQUIRED',
    ]))
    expect(codes(completeRun({
      outcome: 'verified',
      exitCode: 0,
      testSummary: { passed: 2, failed: 1, skipped: 0, targetCount: 3 },
    }))).toContain('VERIFIED_RUN_FAILED_TESTS')
    expect(codes(completeRun({ outcome: 'verified', exitCode: null }))).toContain('VERIFIED_RUN_SUCCESS_SIGNAL_REQUIRED')
    expect(codes(completeRun({
      outcome: 'verified',
      testSummary: { passed: 0, failed: 0, skipped: 2, targetCount: 2 },
    }))).toContain('VERIFIED_RUN_SUCCESS_SIGNAL_REQUIRED')
  })

  it('accepts only complete failed runs with an explicit failure signal', () => {
    expect(codes(completeRun({ outcome: 'failed', exitCode: 2 }))).toEqual([])
    expect(codes(completeRun({
      outcome: 'failed',
      exitCode: 0,
      testSummary: { passed: 2, failed: 1, skipped: 0, targetCount: 3 },
    }))).toEqual([])

    expect(codes(completeRun({ outcome: 'failed', endedAt: null, exitCode: 1 }))).toContain('FAILED_RUN_INCOMPLETE')
    expect(codes(completeRun({ outcome: 'failed', exitCode: 0 }))).toContain('FAILED_RUN_FAILURE_SIGNAL_REQUIRED')
  })

  it('throws one structured error from the assertion helper', () => {
    expect(() => assertRunInvariants(completeRun({ outcome: 'verified', exitCode: 4 }))).toThrow(RunEvidenceInvariantError)
    try {
      assertRunInvariants(completeRun({ outcome: 'verified', exitCode: 4 }))
    } catch (error) {
      expect(error).toBeInstanceOf(RunEvidenceInvariantError)
      expect((error as RunEvidenceInvariantError).violations.map(({ code }) => code)).toContain('VERIFIED_RUN_NONZERO_EXIT')
    }
  })
})

describe('evidence invariants', () => {
  it('does not require a run for non-verified evidence', () => {
    expect(validateEvidenceInvariants({ result: 'recorded' })).toEqual([])
    expect(validateEvidenceInvariants({ result: 'failed' })).toEqual([])
  })

  it('requires a matching, validated run with verified outcome', () => {
    expect(validateEvidenceInvariants({ result: 'verified' }).map(({ code }) => code)).toEqual(['VERIFIED_EVIDENCE_RUN_REQUIRED'])
    expect(validateEvidenceInvariants({ result: 'verified', runId: 'run-1' }).map(({ code }) => code)).toEqual(['VERIFIED_EVIDENCE_RUN_NOT_VALIDATED'])
    expect(validateEvidenceInvariants({ result: 'verified', runId: 'run-1' }, {
      linkedRun: { id: 'run-2', outcome: 'failed', invariantsValid: false },
    }).map(({ code }) => code)).toEqual(expect.arrayContaining([
      'VERIFIED_EVIDENCE_RUN_MISMATCH',
      'VERIFIED_EVIDENCE_RUN_NOT_VALIDATED',
      'VERIFIED_EVIDENCE_RUN_NOT_VERIFIED',
    ]))
    expect(validateEvidenceInvariants({ result: 'verified', runId: 'run-1' }, {
      linkedRun: { id: 'run-1', outcome: 'verified', invariantsValid: true },
    })).toEqual([])
  })

  it('supports an explicit, reasoned verified-evidence override', () => {
    expect(validateEvidenceInvariants({ result: 'verified' }, { verifiedOverride: { reason: 'Manual external verification' } })).toEqual([])
    expect(validateEvidenceInvariants({ result: 'verified' }, { verifiedOverride: { reason: '   ' } }).map(({ code }) => code)).toEqual(['VERIFIED_EVIDENCE_RUN_REQUIRED'])
  })

  it('shares the structured assertion error with run validation', () => {
    expect(() => assertEvidenceInvariants({ result: 'verified' })).toThrow(RunEvidenceInvariantError)
  })
})
