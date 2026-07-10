import type { EvidenceResult, RunOutcome } from './contracts.js'

export interface RunTestSummaryInvariantInput {
  passed: number
  failed: number
  skipped: number
  targetCount: number
}

export interface RunInvariantInput {
  startedAt: string
  endedAt?: string | null
  outcome: RunOutcome
  exitCode?: number | null
  testSummary?: RunTestSummaryInvariantInput | null
}

export interface EvidenceInvariantInput {
  result: EvidenceResult
  runId?: string | null
}

export interface ValidatedRunReference {
  id: string
  outcome: RunOutcome
  invariantsValid: boolean
}

export interface VerifiedEvidenceOverride {
  reason: string
}

export interface EvidenceInvariantContext {
  linkedRun?: ValidatedRunReference | null
  verifiedOverride?: VerifiedEvidenceOverride | null
}

export type RunEvidenceInvariantCode =
  | 'RUN_STARTED_AT_INVALID'
  | 'RUN_ENDED_AT_INVALID'
  | 'RUN_END_BEFORE_START'
  | 'TEST_TOTAL_MISMATCH'
  | 'VERIFIED_RUN_INCOMPLETE'
  | 'VERIFIED_RUN_NONZERO_EXIT'
  | 'VERIFIED_RUN_FAILED_TESTS'
  | 'VERIFIED_RUN_SUCCESS_SIGNAL_REQUIRED'
  | 'FAILED_RUN_INCOMPLETE'
  | 'FAILED_RUN_FAILURE_SIGNAL_REQUIRED'
  | 'VERIFIED_EVIDENCE_RUN_REQUIRED'
  | 'VERIFIED_EVIDENCE_RUN_MISMATCH'
  | 'VERIFIED_EVIDENCE_RUN_NOT_VALIDATED'
  | 'VERIFIED_EVIDENCE_RUN_NOT_VERIFIED'

export interface RunEvidenceInvariantViolation {
  code: RunEvidenceInvariantCode
  path: string
  message: string
}

export class RunEvidenceInvariantError extends Error {
  readonly violations: readonly RunEvidenceInvariantViolation[]

  constructor(violations: readonly RunEvidenceInvariantViolation[]) {
    super(violations.map(({ message }) => message).join('; '))
    this.name = 'RunEvidenceInvariantError'
    this.violations = violations
  }
}

function violation(code: RunEvidenceInvariantCode, path: string, message: string): RunEvidenceInvariantViolation {
  return { code, path, message }
}

function hasExactTestTotal(summary: RunTestSummaryInvariantInput): boolean {
  return summary.passed + summary.failed + summary.skipped === summary.targetCount
}

export function validateRunInvariants(input: RunInvariantInput): RunEvidenceInvariantViolation[] {
  const violations: RunEvidenceInvariantViolation[] = []
  const startedAt = Date.parse(input.startedAt)
  const hasEnded = input.endedAt !== null && input.endedAt !== undefined
  const endedAt = hasEnded ? Date.parse(input.endedAt!) : null

  if (!Number.isFinite(startedAt)) {
    violations.push(violation('RUN_STARTED_AT_INVALID', 'startedAt', 'Run start time must be a valid timestamp'))
  }
  if (hasEnded && !Number.isFinite(endedAt)) {
    violations.push(violation('RUN_ENDED_AT_INVALID', 'endedAt', 'Run end time must be a valid timestamp'))
  }
  if (Number.isFinite(startedAt) && endedAt !== null && Number.isFinite(endedAt) && endedAt < startedAt) {
    violations.push(violation('RUN_END_BEFORE_START', 'endedAt', 'Run end time cannot be earlier than its start time'))
  }

  const testSummary = input.testSummary ?? null
  const exactTestTotal = testSummary === null || hasExactTestTotal(testSummary)
  if (!exactTestTotal) {
    violations.push(violation('TEST_TOTAL_MISMATCH', 'testSummary.targetCount', 'Test target count must equal passed, failed and skipped tests'))
  }

  if (input.outcome === 'verified') {
    if (!hasEnded) {
      violations.push(violation('VERIFIED_RUN_INCOMPLETE', 'endedAt', 'A verified run must be complete'))
    }
    if (input.exitCode !== null && input.exitCode !== undefined && input.exitCode !== 0) {
      violations.push(violation('VERIFIED_RUN_NONZERO_EXIT', 'exitCode', 'A verified run cannot have a non-zero exit code'))
    }
    if (testSummary && testSummary.failed > 0) {
      violations.push(violation('VERIFIED_RUN_FAILED_TESTS', 'testSummary.failed', 'A verified run cannot contain failed tests'))
    }
    const hasSuccessfulExit = input.exitCode === 0
    const hasSuccessfulTests = Boolean(testSummary && exactTestTotal && testSummary.passed > 0 && testSummary.failed === 0)
    if (!hasSuccessfulExit && !hasSuccessfulTests) {
      violations.push(violation('VERIFIED_RUN_SUCCESS_SIGNAL_REQUIRED', 'outcome', 'A verified run requires a zero exit code or at least one passing test'))
    }
  }

  if (input.outcome === 'failed') {
    if (!hasEnded) {
      violations.push(violation('FAILED_RUN_INCOMPLETE', 'endedAt', 'A failed run must be complete'))
    }
    const hasFailedExit = input.exitCode !== null && input.exitCode !== undefined && input.exitCode !== 0
    const hasFailedTests = Boolean(testSummary && testSummary.failed > 0)
    if (!hasFailedExit && !hasFailedTests) {
      violations.push(violation('FAILED_RUN_FAILURE_SIGNAL_REQUIRED', 'outcome', 'A failed run requires a non-zero exit code or at least one failed test'))
    }
  }

  return violations
}

export function assertRunInvariants(input: RunInvariantInput): void {
  const violations = validateRunInvariants(input)
  if (violations.length) throw new RunEvidenceInvariantError(violations)
}

export function validateEvidenceInvariants(input: EvidenceInvariantInput, context: EvidenceInvariantContext = {}): RunEvidenceInvariantViolation[] {
  if (input.result !== 'verified') return []
  if (context.verifiedOverride?.reason.trim()) return []

  if (!input.runId) {
    return [violation('VERIFIED_EVIDENCE_RUN_REQUIRED', 'runId', 'Verified evidence requires a linked verified run')]
  }
  if (!context.linkedRun) {
    return [violation('VERIFIED_EVIDENCE_RUN_NOT_VALIDATED', 'runId', 'Verified evidence requires validation of its linked run')]
  }

  const violations: RunEvidenceInvariantViolation[] = []
  if (context.linkedRun.id !== input.runId) {
    violations.push(violation('VERIFIED_EVIDENCE_RUN_MISMATCH', 'runId', 'Validated run does not match the evidence run'))
  }
  if (!context.linkedRun.invariantsValid) {
    violations.push(violation('VERIFIED_EVIDENCE_RUN_NOT_VALIDATED', 'runId', 'Verified evidence cannot use a run that failed invariant validation'))
  }
  if (context.linkedRun.outcome !== 'verified') {
    violations.push(violation('VERIFIED_EVIDENCE_RUN_NOT_VERIFIED', 'runId', 'Verified evidence requires a run with verified outcome'))
  }
  return violations
}

export function assertEvidenceInvariants(input: EvidenceInvariantInput, context: EvidenceInvariantContext = {}): void {
  const violations = validateEvidenceInvariants(input, context)
  if (violations.length) throw new RunEvidenceInvariantError(violations)
}
