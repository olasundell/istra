import type { Page } from '../domain/contracts.js'

export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0
  try {
    const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

export function pageOf<T>(items: T[], limit: number, cursor?: string | null): Page<T> {
  const start = decodeCursor(cursor)
  const boundedLimit = Math.min(Math.max(limit, 1), 200)
  const pageItems = items.slice(start, start + boundedLimit)
  const nextOffset = start + pageItems.length
  const hasMore = nextOffset < items.length
  return { items: pageItems, nextCursor: hasMore ? encodeCursor(nextOffset) : null, hasMore }
}
