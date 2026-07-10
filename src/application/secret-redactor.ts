export type SecretRedactionKind =
  | 'environment'
  | 'shell-flag'
  | 'header'
  | 'url-userinfo'
  | 'query-parameter'
  | 'json-key'

export interface SecretRedactionMetadata {
  kind: SecretRedactionKind
  name: string
  count: number
}

export interface SecretRedactionResult {
  value: string
  redacted: boolean
  count: number
  redactions: SecretRedactionMetadata[]
}

export interface SecretRedactorOptions {
  /** Names are additive and separator/case insensitive across all supported contexts. */
  secretNames?: readonly string[]
  includeDefaultSecretNames?: boolean
  replacement?: string
}

const DEFAULT_REPLACEMENT = '[REDACTED]'

const DEFAULT_SECRET_NAMES = [
  'access_token',
  'api_key',
  'authorization',
  'bearer_token',
  'client_secret',
  'client_token',
  'connection_string',
  'cookie',
  'database_url',
  'id_token',
  'password',
  'passwd',
  'private_key',
  'refresh_token',
  'secret',
  'session',
  'session_id',
  'session_token',
  'token',
] as const
const normaliseName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')
const DEFAULT_SECRET_SUFFIXES = DEFAULT_SECRET_NAMES.map(normaliseName).filter((name) => name.length >= 5)
const SENSITIVE_NAME_SEGMENTS = new Set(['authorization', 'cookie', 'credential', 'credentials', 'passwd', 'password', 'secret', 'session', 'token'])

function hasSensitiveNameSegment(value: string): boolean {
  const separated = value.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return separated.some((segment) => SENSITIVE_NAME_SEGMENTS.has(segment))
}

function displayName(value: string): string {
  try { return decodeURIComponent(value).toLowerCase() } catch { return value.toLowerCase() }
}

function findJsonStringEnd(value: string, start: number): number | null {
  if (value[start] !== '"') return null
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === '\\') index += 1
    else if (value[index] === '"') return index + 1
  }
  return null
}

function findJsonCompositeEnd(value: string, start: number): number | null {
  const opening = value[start]
  if (opening !== '{' && opening !== '[') return null
  const closings = [opening === '{' ? '}' : ']']

  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === '"') {
      const end = findJsonStringEnd(value, index)
      if (end === null) return null
      index = end - 1
      continue
    }
    if (value[index] === '{') closings.push('}')
    else if (value[index] === '[') closings.push(']')
    else if (value[index] === closings.at(-1)) {
      closings.pop()
      if (closings.length === 0) return index + 1
    }
  }
  return null
}

function findJsonValueEnd(value: string, start: number): number | null {
  if (value[start] === '"') return findJsonStringEnd(value, start)
  if (value[start] === '{' || value[start] === '[') return findJsonCompositeEnd(value, start)
  const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(value.slice(start))
  return primitive ? start + primitive[0].length : null
}

function unquote(value: string): string {
  const quote = value[0]
  return (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value
}

function replacePreservingQuote(value: string, replacement: string): string {
  const quote = value[0]
  return (quote === '"' || quote === "'") && value.at(-1) === quote ? `${quote}${replacement}${quote}` : replacement
}

export class SecretRedactor {
  private readonly replacement: string
  private readonly sensitiveNames: Set<string>
  private readonly sensitiveSuffixes: readonly string[]

  constructor(options: SecretRedactorOptions = {}) {
    this.replacement = options.replacement ?? DEFAULT_REPLACEMENT
    if (!this.replacement) throw new Error('Secret redaction replacement must not be empty')

    const configured = options.secretNames ?? []
    const names = options.includeDefaultSecretNames === false ? configured : [...DEFAULT_SECRET_NAMES, ...configured]
    this.sensitiveNames = new Set(names.map(normaliseName).filter(Boolean))
    this.sensitiveSuffixes = options.includeDefaultSecretNames === false ? [] : DEFAULT_SECRET_SUFFIXES
  }

  redact(input: string): SecretRedactionResult {
    let value = input
    let count = 0
    const metadata = new Map<string, SecretRedactionMetadata>()

    const isSensitive = (name: string): boolean => {
      const normalised = normaliseName(name)
      return this.sensitiveNames.has(normalised)
        || this.sensitiveSuffixes.some((suffix) => normalised.length > suffix.length && normalised.endsWith(suffix))
        || (this.sensitiveSuffixes.length > 0 && hasSensitiveNameSegment(name))
    }
    const record = (kind: SecretRedactionKind, name: string): void => {
      count += 1
      const displayed = displayName(name)
      const key = `${kind}:${normaliseName(displayed)}`
      const existing = metadata.get(key)
      if (existing) existing.count += 1
      else metadata.set(key, { kind, name: displayed, count: 1 })
    }
    const isReplacement = (candidate: string): boolean => unquote(candidate).trim() === this.replacement

    // JSON is scanned rather than parsed wholesale so embedded JSON keeps its original formatting.
    let output = ''
    let copiedUntil = 0
    for (let index = 0; index < value.length;) {
      if (value[index] !== '"') { index += 1; continue }
      const keyEnd = findJsonStringEnd(value, index)
      if (keyEnd === null) break
      let separator = keyEnd
      while (/\s/.test(value[separator] ?? '')) separator += 1
      if (value[separator] !== ':') { index = keyEnd; continue }

      let key: string | null = null
      try {
        const parsed = JSON.parse(value.slice(index, keyEnd)) as unknown
        if (typeof parsed === 'string') key = parsed
      } catch {
        key = null
      }
      let valueStart = separator + 1
      while (/\s/.test(value[valueStart] ?? '')) valueStart += 1
      const valueEnd = key && isSensitive(key) ? findJsonValueEnd(value, valueStart) : null
      if (key && valueEnd !== null && !isReplacement(value.slice(valueStart, valueEnd))) {
        output += value.slice(copiedUntil, valueStart) + JSON.stringify(this.replacement)
        copiedUntil = valueEnd
        record('json-key', key)
        index = valueEnd
      } else {
        index = keyEnd
      }
    }
    if (copiedUntil > 0) value = output + value.slice(copiedUntil)

    value = value.replace(/\b([a-z][a-z\d+.-]*:\/\/)([^/\s?#@]+)@/gi, (match, scheme: string, userinfo: string) => {
      if (userinfo === this.replacement) return match
      record('url-userinfo', 'userinfo')
      return `${scheme}${this.replacement}@`
    })

    value = value.replace(/\b((?:proxy-)?authorization|cookie|set-cookie)(\s*:\s*)([^\r\n"']+)/gi, (match, name: string, separator: string, secret: string) => {
      if (isReplacement(secret)) return match
      record('header', name)
      return `${name}${separator}${this.replacement}`
    })

    value = value.replace(/([?&])([a-z0-9_.%~-]+)(=)([^&#\s"'`]*)/gi, (match, prefix: string, name: string, equals: string, secret: string) => {
      let decodedName = name
      try { decodedName = decodeURIComponent(name.replaceAll('+', ' ')) } catch { /* Preserve undecodable input. */ }
      if (!secret || !isSensitive(decodedName) || isReplacement(secret)) return match
      record('query-parameter', decodedName)
      return `${prefix}${name}${equals}${this.replacement}`
    })

    value = value.replace(/(^|[\s;(])(--?)([a-z][a-z0-9_.-]*)(?:(\s*=\s*)|(\s+))("(?:\\.|[^"\\])*"|'[^']*'|[^\s;,&|)]+)/gim, (match, boundary: string, dashes: string, name: string, equals: string | undefined, spacing: string | undefined, secret: string) => {
      if (!isSensitive(name) || isReplacement(secret)) return match
      record('shell-flag', name)
      return `${boundary}${dashes}${name}${equals ?? spacing ?? ''}${replacePreservingQuote(secret, this.replacement)}`
    })

    value = value.replace(/(^|[\s;,(])((?:export\s+)?)([a-z_][a-z0-9_.-]*)(\s*=\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s;,&|)]+)/gim, (match, boundary: string, declaration: string, name: string, equals: string, secret: string) => {
      if (!isSensitive(name) || isReplacement(secret)) return match
      record('environment', name)
      return `${boundary}${declaration}${name}${equals}${replacePreservingQuote(secret, this.replacement)}`
    })

    return { value, redacted: count > 0, count, redactions: [...metadata.values()] }
  }
}

export function redactSecrets(value: string, options: SecretRedactorOptions = {}): SecretRedactionResult {
  return new SecretRedactor(options).redact(value)
}
