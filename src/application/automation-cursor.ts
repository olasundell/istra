import { ValidationError } from './errors.js'

export interface AutomationCursorState {
  version: 1
  projectId: string
  queueId: string
  sequence: number
  checkedAt: string
}

export function encodeAutomationCursor(state: Omit<AutomationCursorState, 'version'>): string {
  return Buffer.from(JSON.stringify({ version: 1, ...state }), 'utf8').toString('base64url')
}

export function decodeAutomationCursor(cursor: string | undefined, now: string, scope: { projectId: string; queueId: string }): AutomationCursorState {
  if (!cursor) return { version: 1, ...scope, sequence: 0, checkedAt: now }
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<AutomationCursorState>
    if (value.version !== 1) throw new Error('Unsupported cursor version')
    if (value.projectId !== scope.projectId || value.queueId !== scope.queueId) throw new Error('Invalid scope')
    if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) throw new Error('Invalid sequence')
    if (typeof value.checkedAt !== 'string' || Number.isNaN(Date.parse(value.checkedAt))) throw new Error('Invalid timestamp')
    const checkedAt = new Date(value.checkedAt).toISOString()
    if (Date.parse(checkedAt) > Date.parse(now)) throw new Error('Future cursor')
    return { version: 1, ...scope, sequence: Number(value.sequence), checkedAt }
  } catch {
    throw new ValidationError('Invalid automation queue cursor')
  }
}
