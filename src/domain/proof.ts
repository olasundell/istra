import type { EvidenceResult, ProofStatus, RequirementProofExplanation, ValidationStatus } from './contracts.js'

export interface CriterionEvidenceObservation {
  id: string
  ordinal: number
  result: EvidenceResult
  createdAt: string
  stale: boolean
  validationStatus: ValidationStatus
}

export interface CriterionProofInput {
  id: string
  title: string
  required: boolean
  archivedAt?: string | null
  evidence: CriterionEvidenceObservation[]
}

export interface CriterionProof {
  status: ProofStatus
  evidenceId: string | null
  reason: string
}

function newestFirst(left: CriterionEvidenceObservation, right: CriterionEvidenceObservation): number {
  return right.ordinal - left.ordinal
}

export function evaluateCriterionProof(input: CriterionProofInput): CriterionProof {
  const current = input.evidence
    .filter((entry) => !entry.stale && entry.validationStatus !== 'legacy_unvalidated')
    .sort(newestFirst)
  const decisive = current.find((entry) => entry.result === 'verified' || entry.result === 'failed')
  if (decisive?.result === 'verified') return { status: 'proven', evidenceId: decisive.id, reason: 'Latest decisive evidence is verified' }
  if (decisive?.result === 'failed') return { status: 'defect', evidenceId: decisive.id, reason: 'Latest decisive evidence failed' }
  const partial = current.find((entry) => entry.result === 'recorded' || entry.result === 'interrupted')
  if (partial) return { status: 'partial', evidenceId: partial.id, reason: `Latest current evidence is ${partial.result}` }
  return { status: 'open', evidenceId: null, reason: 'No current validated evidence' }
}

export function explainRequirementProof(criteria: Array<CriterionProofInput & CriterionProof>): RequirementProofExplanation {
  const activeRequired = criteria.filter((criterion) => criterion.required && !criterion.archivedAt)
  const count = (status: ProofStatus) => activeRequired.filter((criterion) => criterion.status === status).length
  const defectiveCriteria = count('defect')
  const provenCriteria = count('proven')
  const partialCriteria = count('partial')
  const openCriteria = count('open')
  const status: ProofStatus = activeRequired.length === 0
    ? 'open'
    : defectiveCriteria > 0
      ? 'defect'
      : provenCriteria === activeRequired.length
        ? 'proven'
        : provenCriteria + partialCriteria > 0
          ? 'partial'
          : 'open'
  return {
    status,
    requiredCriteria: activeRequired.length,
    provenCriteria,
    defectiveCriteria,
    partialCriteria,
    openCriteria,
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      title: criterion.title,
      required: criterion.required,
      archivedAt: criterion.archivedAt ?? null,
      proofStatus: criterion.status,
      proofEvidenceId: criterion.evidenceId,
      proofReason: criterion.reason,
    })),
  }
}
