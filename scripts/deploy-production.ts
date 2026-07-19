import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { latestPostgresSchemaVersion, postgresMigrations } from '../src/infrastructure/postgres/migrations.js'

const unsafeDatabaseNames = new Set([
  'admin',
  'default',
  'defaultdb',
  'postgres',
  'root',
  'template0',
  'template1',
])

const secretEnvironmentPattern = /(api_?key|connection_?string|database_?url|password|secret|token)/i
const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost'])

export interface CommandSpec {
  id: string
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface CommandResult {
  stdout: string
  stderr: string
}

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>

export interface DeploymentConfig {
  mode: 'apply' | 'dry-run'
  repoRoot: string
  productionUrl: URL
  productionDatabase: string
  productionTarget: string
  trialDatabase: string
  backupDir: string
  healthBaseUrl: URL
  deploymentId: string
  codexMarketplace: string
  codexPluginSource: string
  codexPluginCacheRoot: string
  codexCachebusterHelper: string
  opencodePackageRoot: string
  opencodeLoader: string
  composeFile: string
  composeEnvFile: string
  composeProject: string
}

export interface DeploymentResult {
  backupPath: string
  backupDigest: string
  codexVersion: string
  opencodePackagePath: string
  rollbackImage: string
}

export interface WorkflowPhases {
  preflight(): Promise<void>
  buildCandidate(): Promise<void>
  dumpTrialSeed(): Promise<void>
  createTrial(): Promise<void>
  restoreTrial(): Promise<void>
  migrateTrial(): Promise<void>
  verifyTrial(): Promise<void>
  prepareClients(): Promise<void>
  stopProduction(): Promise<void>
  verifyNoProductionWriters(): Promise<void>
  backupProduction(): Promise<void>
  migrateProduction(): Promise<void>
  verifyMigratedProduction(): Promise<void>
  promoteCandidate(): Promise<void>
  deployRuntime(): Promise<void>
  activateClients(): Promise<void>
  verifyDeployment(): Promise<void>
  restartUnchangedProduction(): Promise<void>
  cleanupTrial(): Promise<void>
}

export interface WorkflowState {
  trialCreated: boolean
  productionStopped: boolean
  productionMigrationAttempted: boolean
}

function parseArguments(argv: string[]): Map<string, string | true> {
  const parsed = new Map<string, string | true>()
  const valueOptions = new Set(['--backup-dir', '--confirm-target', '--env-file', '--health-url'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--' && index === 0) continue
    if (argument === '--apply' || argument === '--dry-run' || argument === '--help') {
      if (parsed.has(argument)) throw new Error(`Duplicate option: ${argument}`)
      parsed.set(argument, true)
      continue
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown option: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    if (parsed.has(argument)) throw new Error(`Duplicate option: ${argument}`)
    parsed.set(argument, value)
    index += 1
  }
  return parsed
}

function parsePostgresUrl(raw: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`)
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${label} must use postgres:// or postgresql:// and include a host`)
  }
  return parsed
}

function databaseName(url: URL, label: string): string {
  const encoded = url.pathname.replace(/^\//, '')
  if (!encoded || encoded.includes('/')) throw new Error(`${label} must identify exactly one database`)
  let name: string
  try {
    name = decodeURIComponent(encoded)
  } catch {
    throw new Error(`${label} contains an invalid database name`)
  }
  assertSafeProductionDatabase(name, label)
  return name
}

function assertSafeProductionDatabase(name: string, label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(name)) {
    throw new Error(`${label} database name must be 1-63 simple identifier characters`)
  }
  if (unsafeDatabaseNames.has(name.toLowerCase())) {
    throw new Error(`${label} may not target the root, template, admin, or a default database`)
  }
}

export function assertSafeTrialDatabase(trial: string, production: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(trial)) throw new Error('Generated trial database name is unsafe')
  if (trial === production || !trial.startsWith(`${production.toLowerCase().slice(0, 24)}_istra_trial_`)) {
    throw new Error('Trial database does not have the deployment-owned prefix')
  }
  if (unsafeDatabaseNames.has(trial)) throw new Error('Generated trial database name is reserved')
}

function targetOf(url: URL): string {
  const port = url.port || '5432'
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname
  return `${url.protocol}//${host}:${port}/${encodeURIComponent(databaseName(url, 'Database URL'))}`
}

function trialName(production: string, deploymentId: string): string {
  const prefix = production.toLowerCase().slice(0, 24)
  const value = `${prefix}_istra_trial_${deploymentId}`.slice(0, 63)
  assertSafeTrialDatabase(value, production)
  return value
}

function deploymentId(date: Date): string {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

function validateAbsoluteOperationalPath(path: string, label: string): string {
  const resolved = resolve(path)
  if (!isAbsolute(path) || resolved === '/' || resolved === homedir()) {
    throw new Error(`${label} must be an absolute, dedicated subdirectory`)
  }
  return resolved
}

function parseHealthUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('--health-url must be a valid URL')
  }
  if (parsed.protocol !== 'http:' || !loopbackHosts.has(parsed.hostname)) {
    throw new Error('--health-url must use HTTP on a loopback host')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('--health-url may not contain credentials, query data, fragments, or a path')
  }
  return parsed
}

function isSameOrNested(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function requireProductionCredentials(url: URL): void {
  let username: string
  let password: string
  try {
    username = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
  } catch {
    throw new Error('ISTRA_DATABASE_URL contains invalid encoded credentials')
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(username) || !password) {
    throw new Error('ISTRA_DATABASE_URL must include a non-empty simple role name and password')
  }
}

export function createDeploymentConfig(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
  repoRoot = process.cwd(),
): DeploymentConfig {
  const args = parseArguments(argv)
  if (args.has('--help')) throw new Error('HELP')
  if (args.has('--apply') && args.has('--dry-run')) throw new Error('--apply and --dry-run are mutually exclusive')
  for (const variable of ['COMPOSE_FILE', 'COMPOSE_PATH_SEPARATOR', 'COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME', 'DOCKER_CONTEXT', 'DOCKER_HOST']) {
    if (environment[variable]) throw new Error(`${variable} must be unset; deployment pins the local Compose target explicitly`)
  }

  const rawProductionUrl = environment.ISTRA_DATABASE_URL
  if (!rawProductionUrl) throw new Error('ISTRA_DATABASE_URL is required; load the ignored production environment first')
  const productionUrl = parsePostgresUrl(rawProductionUrl, 'ISTRA_DATABASE_URL')
  requireProductionCredentials(productionUrl)
  if (productionUrl.hostname !== '127.0.0.1') {
    throw new Error('The supported Compose deployment requires PostgreSQL on host 127.0.0.1')
  }
  const productionDatabase = databaseName(productionUrl, 'ISTRA_DATABASE_URL')
  const productionTarget = targetOf(productionUrl)

  const confirmation = args.get('--confirm-target')
  if (typeof confirmation !== 'string') {
    throw new Error(`--confirm-target is required and must equal ${productionTarget}`)
  }
  const confirmedUrl = parsePostgresUrl(confirmation, '--confirm-target')
  if (confirmedUrl.username || confirmedUrl.password || confirmedUrl.search || confirmedUrl.hash) {
    throw new Error('--confirm-target must be a credential-free PostgreSQL URL')
  }
  if (targetOf(confirmedUrl) !== productionTarget) {
    throw new Error(`--confirm-target does not match the exact production target ${productionTarget}`)
  }

  const rawBackupDir = args.get('--backup-dir') ?? environment.ISTRA_DEPLOY_BACKUP_DIR
  if (typeof rawBackupDir !== 'string') {
    throw new Error('--backup-dir or ISTRA_DEPLOY_BACKUP_DIR is required')
  }
  const id = deploymentId(now)
  const home = homedir()
  const codexHome = environment.CODEX_HOME ? resolve(environment.CODEX_HOME) : join(home, '.codex')
  const resolvedRepoRoot = resolve(repoRoot)
  const backupDir = validateAbsoluteOperationalPath(rawBackupDir, 'Backup directory')
  if (isSameOrNested(resolvedRepoRoot, backupDir) || isSameOrNested(backupDir, resolvedRepoRoot)) {
    throw new Error('Backup directory and repository must be separate, non-nested paths')
  }
  if (environment.ISTRA_CODEX_MARKETPLACE && environment.ISTRA_CODEX_MARKETPLACE !== 'personal') {
    throw new Error('Guarded deployment supports only the pinned personal Codex marketplace')
  }
  return {
    mode: args.has('--apply') ? 'apply' : 'dry-run',
    repoRoot: resolvedRepoRoot,
    productionUrl,
    productionDatabase,
    productionTarget,
    trialDatabase: trialName(productionDatabase, id),
    backupDir,
    healthBaseUrl: parseHealthUrl(String(args.get('--health-url') ?? environment.ISTRA_DEPLOY_HEALTH_URL ?? 'http://127.0.0.1:4317')),
    deploymentId: id,
    codexMarketplace: 'personal',
    codexPluginSource: validateAbsoluteOperationalPath(
      environment.ISTRA_CODEX_PLUGIN_SOURCE ?? join(home, 'plugins', 'istra'),
      'Codex plugin source',
    ),
    codexPluginCacheRoot: validateAbsoluteOperationalPath(
      environment.ISTRA_CODEX_PLUGIN_CACHE ?? join(codexHome, 'plugins', 'cache', 'personal', 'istra'),
      'Codex plugin cache',
    ),
    codexCachebusterHelper: resolve(
      environment.ISTRA_CODEX_CACHEBUSTER_HELPER
        ?? join(codexHome, 'skills', '.system', 'plugin-creator', 'scripts', 'update_plugin_cachebuster.py'),
    ),
    opencodePackageRoot: validateAbsoluteOperationalPath(
      environment.ISTRA_OPENCODE_PACKAGE_ROOT
        ?? join(home, '.local', 'share', 'opencode', 'plugins', 'opencode-istra'),
      'OpenCode package root',
    ),
    opencodeLoader: resolve(
      environment.ISTRA_OPENCODE_LOADER ?? join(home, '.config', 'opencode', 'plugins', 'istra.js'),
    ),
    composeFile: join(resolvedRepoRoot, 'compose.yaml'),
    composeEnvFile: (() => {
      const supplied = args.get('--env-file')
      if (typeof supplied === 'string' && !isAbsolute(supplied)) throw new Error('--env-file must be an absolute path')
      return resolve(String(supplied ?? join(resolvedRepoRoot, '.env')))
    })(),
    composeProject: 'istra',
  }
}

export async function loadPinnedEnvironmentFile(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  repoRoot = process.cwd(),
): Promise<string> {
  const args = parseArguments(argv)
  const supplied = args.get('--env-file')
  if (typeof supplied === 'string' && !isAbsolute(supplied)) throw new Error('--env-file must be an absolute path')
  const path = resolve(String(supplied ?? join(resolve(repoRoot), '.env')))
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Pinned environment path must be a regular, non-symlink file')
  if ((info.mode & 0o077) !== 0) throw new Error('Pinned environment file must not be accessible by group or other users')
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('Pinned environment file must be owned by the deployment user')
  }
  if (!environment.ISTRA_DATABASE_URL) {
    if (environment !== process.env) throw new Error('Injected environments must provide ISTRA_DATABASE_URL directly')
    process.loadEnvFile(path)
  }
  return path
}

export function describeDeployment(config: DeploymentConfig): string {
  return [
    `Mode: ${config.mode}`,
    `Production target: ${config.productionTarget}`,
    `Disposable trial database: ${config.trialDatabase}`,
    `Expected schema after migration: ${latestPostgresSchemaVersion}`,
    `Backup directory: ${config.backupDir}`,
    `Pinned Compose project: ${config.composeProject}`,
    `Pinned Compose file: ${config.composeFile}`,
    `Pinned environment file: ${config.composeEnvFile}`,
    'Order:',
    '  1. Validate a clean source revision, exact Compose target, tools, tests, and candidate image.',
    '  2. Dump production consistently, restore into the generated trial database, migrate it, and run PostgreSQL verification.',
    '  3. Prepare immutable Codex and OpenCode packages without activating them.',
    '  4. Stop the application, refuse any remaining production writer, and create plus verify a production backup.',
    '  5. Migrate production, force-recreate the Compose application, and verify PostgreSQL readiness with automation disabled.',
    '  6. Atomically activate the packaged clients, verify their installations, and drop the trial database.',
  ].join('\n')
}

function safeBaseEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => (
    !secretEnvironmentPattern.test(key)
    && !key.startsWith('ISTRA_')
    && !key.startsWith('POSTGRES_')
    && !key.startsWith('PG')
  )))
}

function urlForDatabase(url: URL, database: string): URL {
  const copy = new URL(url)
  copy.pathname = `/${encodeURIComponent(database)}`
  return copy
}

function postgresEnvironment(url: URL, database: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  }
  const supportedParameters: Record<string, string> = {
    sslmode: 'PGSSLMODE',
    sslrootcert: 'PGSSLROOTCERT',
    sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY',
    options: 'PGOPTIONS',
  }
  for (const [key, value] of url.searchParams) {
    const variable = supportedParameters[key]
    if (!variable) throw new Error(`Unsupported PostgreSQL URL parameter for guarded deployment: ${key}`)
    env[variable] = value
  }
  return env
}

function runtimeEnvironment(url: URL, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    ISTRA_STORAGE: 'postgresql',
    ISTRA_DATABASE_URL: url.toString(),
  }
}

function testEnvironment(url: URL, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, TEST_DATABASE_URL: url.toString() }
}

export function createProcessRunner(log: (message: string) => void = console.log): CommandRunner {
  return async (spec) => {
    log(`[deploy] ${spec.id}`)
    return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      const collect = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength
        if (outputBytes > 16 * 1024 * 1024) {
          child.kill('SIGTERM')
          return
        }
        target.push(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
      child.on('error', () => rejectPromise(new Error(`${spec.id} could not start`)))
      child.on('close', (code) => {
        if (outputBytes > 16 * 1024 * 1024) {
          rejectPromise(new Error(`${spec.id} exceeded the bounded output limit`))
          return
        }
        if (code !== 0) {
          rejectPromise(new Error(`${spec.id} failed with exit code ${code ?? 'unknown'}`))
          return
        }
        resolvePromise({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      })
    })
  }
}

export async function executeTrialFirstWorkflow(phases: WorkflowPhases): Promise<WorkflowState> {
  const state: WorkflowState = { trialCreated: false, productionStopped: false, productionMigrationAttempted: false }
  let failure: unknown
  try {
    await phases.preflight()
    await phases.buildCandidate()
    await phases.dumpTrialSeed()
    await phases.createTrial()
    state.trialCreated = true
    await phases.restoreTrial()
    await phases.migrateTrial()
    await phases.verifyTrial()
    await phases.prepareClients()
    state.productionStopped = true
    await phases.stopProduction()
    await phases.verifyNoProductionWriters()
    await phases.backupProduction()
    state.productionMigrationAttempted = true
    await phases.migrateProduction()
    await phases.verifyMigratedProduction()
    await phases.promoteCandidate()
    await phases.deployRuntime()
    await phases.activateClients()
    await phases.verifyDeployment()
  } catch (error) {
    failure = error
  } finally {
    if (state.trialCreated) {
      try {
        await phases.cleanupTrial()
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : 'unknown cleanup error'
        if (failure) {
          const failureMessage = failure instanceof Error ? failure.message : 'deployment failed'
          failure = new Error(`${failureMessage}; disposable trial cleanup also failed: ${cleanupMessage}`)
        } else {
          failure = cleanupError
        }
      }
    }
    if (state.productionStopped && !state.productionMigrationAttempted && failure) {
      try {
        await phases.restartUnchangedProduction()
      } catch (restartError) {
        const restartMessage = restartError instanceof Error ? restartError.message : 'unknown restart error'
        const failureMessage = failure instanceof Error ? failure.message : 'deployment failed'
        failure = new Error(`${failureMessage}; unchanged production restart also failed: ${restartMessage}`)
      }
    }
  }
  if (failure) throw failure
  return state
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function integerOutput(value: string, label: string): number {
  const parsed = Number.parseInt(value.trim(), 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} returned an invalid count`)
  return parsed
}

function assertStorageStatus(output: string, expectedDatabase: string, label: string): void {
  assertStorageStatusAtSchema(output, expectedDatabase, latestPostgresSchemaVersion, label)
}

function assertStorageStatusAtSchema(output: string, expectedDatabase: string, expectedSchema: number, label: string): void {
  const status = parseJson<{ backend?: unknown; ready?: unknown; schemaVersion?: unknown; target?: unknown }>(output, label)
  if (status.backend !== 'postgresql' || status.ready !== true || status.schemaVersion !== expectedSchema) {
    throw new Error(`${label} did not report ready PostgreSQL schema ${expectedSchema}`)
  }
  if (typeof status.target !== 'string') throw new Error(`${label} omitted its redacted target`)
  const target = parsePostgresUrl(status.target, `${label} target`)
  if (databaseName(target, `${label} target`) !== expectedDatabase) {
    throw new Error(`${label} reported the wrong database`)
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function assertMatchingFile(source: string, installed: string, label: string): Promise<void> {
  if (await hashFile(source) !== await hashFile(installed)) throw new Error(`${label} does not match the built package`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function assertAbsent(path: string, label: string): Promise<void> {
  if (await pathExists(path)) throw new Error(`${label} already exists; inspect it before retrying`)
}

async function copyCleanPluginBundle(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    filter: (path) => {
      const pathWithinPlugin = relative(source, path)
      return pathWithinPlugin === '' || pathWithinPlugin.split('/')[0] !== 'dist'
    },
  })
  await mkdir(join(destination, 'dist', 'mcp'), { recursive: true })
  await copyFile(join(source, 'dist', 'server.mjs'), join(destination, 'dist', 'server.mjs'))
  await copyFile(join(source, 'dist', 'mcp', 'stdio.mjs'), join(destination, 'dist', 'mcp', 'stdio.mjs'))
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.next.${process.pid}`
  await assertAbsent(temporary, 'Atomic write temporary path')
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function restoreOpenCodeLoader(loader: string, previous: string, previouslyExisted: boolean): Promise<void> {
  if (!previouslyExisted) {
    await rm(loader, { force: true })
    return
  }
  if (!await pathExists(previous)) throw new Error('OpenCode loader rollback file is missing')
  await copyFile(previous, loader)
}

function command(
  runner: CommandRunner,
  config: DeploymentConfig,
  baseEnvironment: NodeJS.ProcessEnv,
  id: string,
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = baseEnvironment,
): Promise<CommandResult> {
  return runner({ id, command: executable, args, cwd: config.repoRoot, env })
}

function composeArguments(config: DeploymentConfig, args: string[]): string[] {
  return [
    'compose',
    '--project-name',
    config.composeProject,
    '--file',
    config.composeFile,
    '--env-file',
    config.composeEnvFile,
    ...args,
  ]
}

interface PreparedClients {
  codexStage: string
  codexPrevious: string
  codexVersion: string
  opencodePackagePath: string
  opencodeLoaderPrevious: string
}

export async function runDeployment(
  config: DeploymentConfig,
  runner: CommandRunner = createProcessRunner(),
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<DeploymentResult | null> {
  console.log(describeDeployment(config))
  if (config.mode === 'dry-run') {
    console.log('Dry run only: the pinned environment was read, but no commands, database connections, file writes, or runtime changes were made.')
    return null
  }

  const baseEnvironment = safeBaseEnvironment(sourceEnvironment)
  const productionPgEnvironment = postgresEnvironment(config.productionUrl, config.productionDatabase, baseEnvironment)
  const trialUrl = urlForDatabase(config.productionUrl, config.trialDatabase)
  const trialPgEnvironment = postgresEnvironment(config.productionUrl, config.trialDatabase, baseEnvironment)
  const trialRuntimeEnvironment = runtimeEnvironment(trialUrl, baseEnvironment)
  const productionRuntimeEnvironment = runtimeEnvironment(config.productionUrl, baseEnvironment)
  const lockDirectory = join(config.backupDir, '.istra-deploy.lock')
  const temporaryDirectory = join(config.backupDir, `.istra-trial-${config.deploymentId}`)
  const trialDump = join(temporaryDirectory, 'production-seed.dump')
  const backupPath = join(
    config.backupDir,
    `istra-${config.productionDatabase}-pre-schema-${latestPostgresSchemaVersion}-${config.deploymentId}.dump`,
  )
  const backupTemporary = `${backupPath}.partial`
  const backupDigestPath = `${backupPath}.sha256`
  const rollbackImage = `istra:rollback-${config.deploymentId}`
  const candidateImage = `istra:candidate-${config.deploymentId}`
  const builtPluginRoot = join(config.repoRoot, 'plugins', 'istra')
  const codexStage = `${config.codexPluginSource}.next.${config.deploymentId}`
  const codexPrevious = `${config.codexPluginSource}.previous.${config.deploymentId}`
  const opencodePackagePath = join(config.opencodePackageRoot, `0.1.0+deploy.${config.deploymentId}`)
  const opencodeLoaderPrevious = `${config.opencodeLoader}.previous.${config.deploymentId}`
  let prepared: PreparedClients | undefined
  let productionProjectCount = -1
  let productionIdentity = ''
  let productionSchemaVersion = -1
  let trialCoreSignature = ''
  let backupDigest = ''
  let lockAcquired = false
  let deploymentSucceeded = false
  let clientsActivated = false
  let candidateImageId = ''
  const previousUmask = process.umask(0o077)

  try {
    await mkdir(config.backupDir, { recursive: true, mode: 0o700 })
    await assertAbsent(lockDirectory, 'Deployment lock')
    await assertAbsent(temporaryDirectory, 'Trial temporary directory')
    await assertAbsent(backupPath, 'Production backup')
    await assertAbsent(backupTemporary, 'Partial production backup')
    await assertAbsent(backupDigestPath, 'Production backup digest')
    await mkdir(lockDirectory, { mode: 0o700 })
    lockAcquired = true
  } catch (error) {
    process.umask(previousUmask)
    throw error
  }

  const phases: WorkflowPhases = {
    async preflight() {
      const tools: Array<[string, string, string[]]> = [
        ['tool.git', 'git', ['--version']],
        ['tool.pnpm', 'pnpm', ['--version']],
        ['tool.docker', 'docker', ['--version']],
        ['tool.pg_dump', 'pg_dump', ['--version']],
        ['tool.pg_restore', 'pg_restore', ['--version']],
        ['tool.createdb', 'createdb', ['--version']],
        ['tool.dropdb', 'dropdb', ['--version']],
        ['tool.psql', 'psql', ['--version']],
        ['tool.codex', 'codex', ['--version']],
        ['tool.opencode', 'opencode', ['--version']],
        ['tool.python', 'python3', ['--version']],
      ]
      for (const [id, executable, args] of tools) await command(runner, config, baseEnvironment, id, executable, args)

      const status = await command(runner, config, baseEnvironment, 'source.clean', 'git', ['status', '--porcelain'])
      if (status.stdout.trim()) throw new Error('Apply mode requires a clean tracked and untracked working tree')
      await access(config.composeFile)
      await access(config.composeEnvFile)
      await command(runner, config, baseEnvironment, 'compose.valid', 'docker', composeArguments(config, ['config', '--quiet']))
      const composeJson = await command(runner, config, baseEnvironment, 'compose.target', 'docker', composeArguments(config, ['config', '--format', 'json']))
      const compose = parseJson<{
        services?: {
          istra?: { environment?: Record<string, unknown> }
          postgres?: {
            environment?: Record<string, unknown>
            ports?: Array<{ host_ip?: unknown; mode?: unknown; protocol?: unknown; published?: unknown; target?: unknown }>
          }
        }
      }>(composeJson.stdout, 'Resolved Compose configuration')
      const composeUrl = compose.services?.istra?.environment?.ISTRA_DATABASE_URL
      const composeDatabase = compose.services?.postgres?.environment?.POSTGRES_DB
      const composeUser = compose.services?.postgres?.environment?.POSTGRES_USER
      const composePassword = compose.services?.postgres?.environment?.POSTGRES_PASSWORD
      const configuredUser = decodeURIComponent(config.productionUrl.username)
      const configuredPassword = decodeURIComponent(config.productionUrl.password)
      if (typeof composeUrl !== 'string') throw new Error('Resolved Compose application has no PostgreSQL target')
      const parsedComposeUrl = parsePostgresUrl(composeUrl, 'Compose Istra target')
      if (
        parsedComposeUrl.hostname !== 'postgres'
        || (parsedComposeUrl.port || '5432') !== '5432'
        || databaseName(parsedComposeUrl, 'Compose Istra target') !== config.productionDatabase
        || decodeURIComponent(parsedComposeUrl.username) !== configuredUser
        || decodeURIComponent(parsedComposeUrl.password) !== configuredPassword
      ) {
        throw new Error('Resolved Compose application does not target the confirmed production database')
      }
      if (composeDatabase !== config.productionDatabase || composeUser !== configuredUser || composePassword !== configuredPassword) {
        throw new Error('Resolved Compose PostgreSQL identity does not match the confirmed production target')
      }
      const postgresPorts = compose.services?.postgres?.ports
      const expectedHostPort = config.productionUrl.port || '5432'
      if (
        !Array.isArray(postgresPorts)
        || postgresPorts.length !== 1
        || postgresPorts[0]?.host_ip !== '127.0.0.1'
        || postgresPorts[0]?.target !== 5432
        || String(postgresPorts[0]?.published) !== expectedHostPort
        || postgresPorts[0]?.protocol !== 'tcp'
      ) {
        throw new Error('Resolved Compose PostgreSQL port does not match the confirmed loopback target')
      }

      const currentDatabase = await command(
        runner,
        config,
        baseEnvironment,
        'production.identity',
        'psql',
        ['--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', "SELECT current_database() || '|' || current_user"],
        productionPgEnvironment,
      )
      productionIdentity = currentDatabase.stdout.trim()
      if (productionIdentity !== `${config.productionDatabase}|${configuredUser}`) {
        throw new Error('PostgreSQL connected with an identity other than the confirmed production database and role')
      }
      const migrationHistory = await command(
        runner,
        config,
        baseEnvironment,
        'production.migration-history',
        'psql',
        [
          '--no-psqlrc',
          '--tuples-only',
          '--no-align',
          '--set',
          'ON_ERROR_STOP=1',
          '--command',
          "SELECT COALESCE(json_agg(json_build_object('version',version,'name',name) ORDER BY version),'[]'::json) FROM schema_migrations",
        ],
        productionPgEnvironment,
      )
      const applied = parseJson<Array<{ version?: unknown; name?: unknown }>>(migrationHistory.stdout.trim(), 'Production migration history')
      if (applied.length === 0 || applied.length > postgresMigrations.length) {
        throw new Error('Production migration history has an unexpected length')
      }
      for (const [index, migration] of applied.entries()) {
        const expected = postgresMigrations[index]
        if (!expected || migration.version !== expected.version || migration.name !== expected.name) {
          throw new Error('Production migration history is not a prefix of this release')
        }
      }
      productionSchemaVersion = Number(applied.at(-1)!.version)
      const currentStorage = await command(
        runner,
        config,
        baseEnvironment,
        'production.current-runtime-storage',
        'curl',
        ['--silent', '--show-error', '--fail', new URL('/api/v1/storage', config.healthBaseUrl).href],
      )
      assertStorageStatusAtSchema(currentStorage.stdout, config.productionDatabase, productionSchemaVersion, 'Current runtime storage endpoint')
      const initialProjectCount = await command(
        runner,
        config,
        baseEnvironment,
        'production.preflight-project-count',
        'psql',
        ['--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT count(*) FROM projects'],
        productionPgEnvironment,
      )
      productionProjectCount = integerOutput(initialProjectCount.stdout, 'Production project count')
      if (productionProjectCount === 0) throw new Error('Production contains no projects; refusing an unexpected empty target')
      await access(config.codexCachebusterHelper)
      await access(join(builtPluginRoot, '.codex-plugin', 'plugin.json'))
      const installed = await command(
        runner,
        config,
        baseEnvironment,
        'codex.source',
        'codex',
        ['plugin', 'list', '--marketplace', config.codexMarketplace, '--json'],
      )
      const listing = parseJson<{
        installed?: Array<{ pluginId?: unknown; source?: { source?: unknown; path?: unknown } }>
      }>(installed.stdout, 'Codex plugin listing')
      const plugin = listing.installed?.find((entry) => entry.pluginId === `istra@${config.codexMarketplace}`)
      if (plugin?.source?.source !== 'local' || resolve(String(plugin.source.path)) !== config.codexPluginSource) {
        throw new Error('Codex Istra must already come from the exact configured local marketplace source')
      }

      await command(runner, config, baseEnvironment, 'source.verify', 'pnpm', ['check'])
      const afterCheck = await command(runner, config, baseEnvironment, 'source.reproducible', 'git', ['status', '--porcelain'])
      if (afterCheck.stdout.trim()) throw new Error('Source verification changed the working tree; commit reproducible build artefacts before deployment')
    },

    async buildCandidate() {
      const previousImage = await command(
        runner,
        config,
        baseEnvironment,
        'runtime.previous-image',
        'docker',
        ['image', 'inspect', 'istra:local', '--format', '{{.Id}}'],
      )
      if (!/^sha256:[a-f0-9]{64}$/.test(previousImage.stdout.trim())) {
        throw new Error('The existing production image could not be identified for rollback')
      }
      await command(runner, config, baseEnvironment, 'runtime.tag-rollback', 'docker', ['image', 'tag', 'istra:local', rollbackImage])
      await command(runner, config, baseEnvironment, 'runtime.build-candidate', 'docker', ['build', '--tag', candidateImage, '.'])
      const candidateIdentity = await command(
        runner,
        config,
        baseEnvironment,
        'runtime.candidate-image',
        'docker',
        ['image', 'inspect', candidateImage, '--format', '{{.Id}}'],
      )
      candidateImageId = candidateIdentity.stdout.trim()
      if (!/^sha256:[a-f0-9]{64}$/.test(candidateImageId)) throw new Error('Candidate image identity is invalid')
    },

    async dumpTrialSeed() {
      await mkdir(temporaryDirectory, { mode: 0o700 })
      await command(
        runner,
        config,
        baseEnvironment,
        'trial.dump-production',
        'pg_dump',
        ['--format=custom', '--no-owner', '--no-acl', `--file=${trialDump}`],
        productionPgEnvironment,
      )
      await chmod(trialDump, 0o600)
      await command(runner, config, baseEnvironment, 'trial.verify-dump', 'pg_restore', ['--list', trialDump])
    },

    async createTrial() {
      assertSafeTrialDatabase(config.trialDatabase, config.productionDatabase)
      await command(
        runner,
        config,
        baseEnvironment,
        'trial.create',
        'createdb',
        [`--owner=${decodeURIComponent(config.productionUrl.username)}`, config.trialDatabase],
        productionPgEnvironment,
      )
    },

    async restoreTrial() {
      await command(
        runner,
        config,
        baseEnvironment,
        'trial.restore',
        'pg_restore',
        ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', `--dbname=${config.trialDatabase}`, trialDump],
        trialPgEnvironment,
      )
      const signature = await command(
        runner,
        config,
        baseEnvironment,
        'trial.pre-migration-signature',
        'psql',
        [
          '--no-psqlrc',
          '--tuples-only',
          '--no-align',
          '--set',
          'ON_ERROR_STOP=1',
          '--command',
          "SELECT json_build_object('projects',(SELECT count(*) FROM projects),'workItems',(SELECT count(*) FROM work_items),'updates',(SELECT count(*) FROM updates),'checkpoints',(SELECT count(*) FROM checkpoint_snapshots),'checkpointDigests',(SELECT COALESCE(md5(string_agg(digest,',' ORDER BY checkpoint_id)),'empty') FROM checkpoint_snapshots))",
        ],
        trialPgEnvironment,
      )
      trialCoreSignature = signature.stdout.trim()
      parseJson<Record<string, unknown>>(trialCoreSignature, 'Trial pre-migration core signature')
    },

    async migrateTrial() {
      await command(runner, config, baseEnvironment, 'trial.migrate', 'pnpm', ['migrate'], trialRuntimeEnvironment)
    },

    async verifyTrial() {
      const status = await command(runner, config, baseEnvironment, 'trial.storage-status', 'pnpm', ['storage:status'], trialRuntimeEnvironment)
      assertStorageStatus(status.stdout, config.trialDatabase, 'Trial storage status')
      const migratedSignature = await command(
        runner,
        config,
        baseEnvironment,
        'trial.post-migration-signature',
        'psql',
        [
          '--no-psqlrc',
          '--tuples-only',
          '--no-align',
          '--set',
          'ON_ERROR_STOP=1',
          '--command',
          "SELECT json_build_object('projects',(SELECT count(*) FROM projects),'workItems',(SELECT count(*) FROM work_items),'updates',(SELECT count(*) FROM updates),'checkpoints',(SELECT count(*) FROM checkpoint_snapshots),'checkpointDigests',(SELECT COALESCE(md5(string_agg(digest,',' ORDER BY checkpoint_id)),'empty') FROM checkpoint_snapshots))",
        ],
        trialPgEnvironment,
      )
      if (!trialCoreSignature || migratedSignature.stdout.trim() !== trialCoreSignature) {
        throw new Error('Trial migration changed core counts or checkpoint digests')
      }
      const policyCount = await command(
        runner,
        config,
        baseEnvironment,
        'trial.automation-disabled',
        'psql',
        ['--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT count(*) FROM work_queue_automation_policies WHERE enabled'],
        trialPgEnvironment,
      )
      if (integerOutput(policyCount.stdout, 'Trial enabled automation policy count') !== 0) {
        throw new Error('Trial migration has enabled queue automation; production will not be touched')
      }
      const emptyAutomationLedger = await command(
        runner,
        config,
        baseEnvironment,
        'trial.empty-automation-ledger',
        'psql',
        [
          '--no-psqlrc',
          '--tuples-only',
          '--no-align',
          '--set',
          'ON_ERROR_STOP=1',
          '--command',
          'SELECT (SELECT count(*) FROM work_leases) + (SELECT count(*) FROM automation_attempts)',
        ],
        trialPgEnvironment,
      )
      if (integerOutput(emptyAutomationLedger.stdout, 'Trial lease and attempt count') !== 0) {
        throw new Error('Trial migration created leases or attempts; production will not be touched')
      }
      const retentionIndex = await command(
        runner,
        config,
        baseEnvironment,
        'trial.retention-index',
        'psql',
        [
          '--no-psqlrc',
          '--tuples-only',
          '--no-align',
          '--set',
          'ON_ERROR_STOP=1',
          '--command',
          "SELECT count(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname='automation_queue_changes_queue'",
        ],
        trialPgEnvironment,
      )
      if (integerOutput(retentionIndex.stdout, 'Trial retention index count') !== 1) {
        throw new Error('Trial migration is missing the queue-change retention index')
      }
      const count = await command(
        runner,
        config,
        baseEnvironment,
        'trial.project-count',
        'psql',
        ['--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT count(*) FROM projects'],
        trialPgEnvironment,
      )
      if (integerOutput(count.stdout, 'Trial project count') !== productionProjectCount) {
        throw new Error('Trial clone project count differs from the production snapshot')
      }
      await command(runner, config, baseEnvironment, 'trial.postgres-tests', 'pnpm', ['test:postgres'], testEnvironment(trialUrl, baseEnvironment))
      const postgresContainer = await command(
        runner,
        config,
        baseEnvironment,
        'trial.postgres-container',
        'docker',
        composeArguments(config, ['ps', '--quiet', 'postgres']),
      )
      const postgresContainerId = postgresContainer.stdout.trim()
      if (!/^[a-f0-9]{12,64}$/.test(postgresContainerId)) {
        throw new Error('Compose PostgreSQL container identity is missing or invalid')
      }
      const candidateTrialUrl = new URL(trialUrl)
      candidateTrialUrl.hostname = '127.0.0.1'
      candidateTrialUrl.port = '5432'
      const candidateStatus = await command(
        runner,
        config,
        baseEnvironment,
        'trial.candidate-image-smoke',
        'docker',
        [
          'run',
          '--rm',
          '--network',
          `container:${postgresContainerId}`,
          '--env',
          'ISTRA_STORAGE',
          '--env',
          'ISTRA_DATABASE_URL',
          candidateImage,
          'node',
          'dist/cli/storage-status.js',
        ],
        runtimeEnvironment(candidateTrialUrl, baseEnvironment),
      )
      assertStorageStatus(candidateStatus.stdout, config.trialDatabase, 'Candidate image trial storage status')
    },

    async prepareClients() {
      await assertAbsent(codexStage, 'Codex staged package')
      await assertAbsent(codexPrevious, 'Codex rollback package')
      await assertAbsent(opencodePackagePath, 'OpenCode immutable package')
      await assertAbsent(opencodeLoaderPrevious, 'OpenCode loader rollback file')
      await copyCleanPluginBundle(builtPluginRoot, codexStage)
      await command(
        runner,
        config,
        baseEnvironment,
        'codex.cachebuster',
        'python3',
        [config.codexCachebusterHelper, codexStage, '--cachebuster', `deploy-${config.deploymentId}`],
      )
      const codexManifest = parseJson<{ version?: unknown }>(
        await readFile(join(codexStage, '.codex-plugin', 'plugin.json'), 'utf8'),
        'Staged Codex manifest',
      )
      if (typeof codexManifest.version !== 'string' || !codexManifest.version.endsWith(`+codex.deploy-${config.deploymentId}`)) {
        throw new Error('Codex cachebuster helper did not produce the expected version')
      }
      await command(runner, config, baseEnvironment, 'codex.syntax-server', 'node', ['--check', join(codexStage, 'dist', 'server.mjs')])
      await command(runner, config, baseEnvironment, 'codex.syntax-mcp', 'node', ['--check', join(codexStage, 'dist', 'mcp', 'stdio.mjs')])

      await mkdir(config.opencodePackageRoot, { recursive: true, mode: 0o700 })
      await copyCleanPluginBundle(builtPluginRoot, opencodePackagePath)
      await command(runner, config, baseEnvironment, 'opencode.syntax-server', 'node', ['--check', join(opencodePackagePath, 'dist', 'server.mjs')])
      await command(runner, config, baseEnvironment, 'opencode.syntax-mcp', 'node', ['--check', join(opencodePackagePath, 'dist', 'mcp', 'stdio.mjs')])
      await assertMatchingFile(join(builtPluginRoot, 'dist', 'server.mjs'), join(opencodePackagePath, 'dist', 'server.mjs'), 'OpenCode server runtime')
      await assertMatchingFile(join(builtPluginRoot, 'dist', 'mcp', 'stdio.mjs'), join(opencodePackagePath, 'dist', 'mcp', 'stdio.mjs'), 'OpenCode MCP runtime')
      prepared = {
        codexStage,
        codexPrevious,
        codexVersion: codexManifest.version,
        opencodePackagePath,
        opencodeLoaderPrevious,
      }
    },

    async stopProduction() {
      await command(runner, config, baseEnvironment, 'production.stop-runtime', 'docker', composeArguments(config, ['stop', 'istra']))
    },

    async verifyNoProductionWriters() {
      const writers = await command(
        runner,
        config,
        baseEnvironment,
        'production.no-other-connections',
        'psql',
        [
          '--no-psqlrc',
          '--tuples-only',
          '--no-align',
          '--set',
          'ON_ERROR_STOP=1',
          '--command',
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
        ],
        productionPgEnvironment,
      )
      if (integerOutput(writers.stdout, 'Production connection count') !== 0) {
        throw new Error('Production still has database connections; stop Codex, OpenCode, native API, and other writers before retrying')
      }
      const identity = await command(
        runner,
        config,
        baseEnvironment,
        'production.quiescent-identity',
        'psql',
        ['--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', "SELECT current_database() || '|' || current_user"],
        productionPgEnvironment,
      )
      if (identity.stdout.trim() !== productionIdentity) {
        throw new Error('Quiescent PostgreSQL target identity differs from the preflight target')
      }
      const projectCount = await command(
        runner,
        config,
        baseEnvironment,
        'production.quiescent-project-count',
        'psql',
        ['--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT count(*) FROM projects'],
        productionPgEnvironment,
      )
      if (integerOutput(projectCount.stdout, 'Quiescent production project count') !== productionProjectCount) {
        throw new Error('Production project count changed during the trial; restart from a fresh trial snapshot')
      }
      const schemaVersion = await command(
        runner,
        config,
        baseEnvironment,
        'production.quiescent-schema-version',
        'psql',
        ['--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT COALESCE(max(version),0) FROM schema_migrations'],
        productionPgEnvironment,
      )
      if (integerOutput(schemaVersion.stdout, 'Quiescent production schema version') !== productionSchemaVersion) {
        throw new Error('Production schema changed during the trial; restart from a fresh trial snapshot')
      }
    },

    async backupProduction() {
      await command(
        runner,
        config,
        baseEnvironment,
        'production.backup',
        'pg_dump',
        ['--format=custom', '--no-owner', '--no-acl', `--file=${backupTemporary}`],
        productionPgEnvironment,
      )
      await chmod(backupTemporary, 0o600)
      const backupInfo = await stat(backupTemporary)
      if (!backupInfo.isFile() || backupInfo.size === 0) throw new Error('Production backup is empty')
      await command(runner, config, baseEnvironment, 'production.verify-backup', 'pg_restore', ['--list', backupTemporary])
      backupDigest = await hashFile(backupTemporary)
      await rename(backupTemporary, backupPath)
      await writeAtomic(backupDigestPath, `${backupDigest}  ${basename(backupPath)}\n`, 0o600)
    },

    async migrateProduction() {
      await command(runner, config, baseEnvironment, 'production.migrate', 'pnpm', ['migrate'], productionRuntimeEnvironment)
    },

    async verifyMigratedProduction() {
      const status = await command(runner, config, baseEnvironment, 'production.storage-status', 'pnpm', ['storage:status'], productionRuntimeEnvironment)
      assertStorageStatus(status.stdout, config.productionDatabase, 'Production storage status')
      const policyCount = await command(
        runner,
        config,
        baseEnvironment,
        'production.automation-disabled',
        'psql',
        ['--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT count(*) FROM work_queue_automation_policies WHERE enabled'],
        productionPgEnvironment,
      )
      if (integerOutput(policyCount.stdout, 'Production enabled automation policy count') !== 0) {
        throw new Error('Production queue automation is unexpectedly enabled; runtime remains stopped')
      }
      const projectCount = await command(
        runner,
        config,
        baseEnvironment,
        'production.post-migration-project-count',
        'psql',
        ['--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT count(*) FROM projects'],
        productionPgEnvironment,
      )
      if (integerOutput(projectCount.stdout, 'Post-migration production project count') !== productionProjectCount) {
        throw new Error('Production project count changed during migration; runtime remains stopped')
      }
    },

    async promoteCandidate() {
      const candidateIdentity = await command(
        runner,
        config,
        baseEnvironment,
        'runtime.recheck-candidate-image',
        'docker',
        ['image', 'inspect', candidateImage, '--format', '{{.Id}}'],
      )
      if (!candidateImageId || candidateIdentity.stdout.trim() !== candidateImageId) {
        throw new Error('Candidate image tag changed after trial verification; runtime remains stopped')
      }
      await command(runner, config, baseEnvironment, 'runtime.promote-candidate', 'docker', ['image', 'tag', candidateImage, 'istra:local'])
    },

    async deployRuntime() {
      await command(
        runner,
        config,
        baseEnvironment,
        'production.start-runtime',
        'docker',
        composeArguments(config, ['up', '--detach', '--wait', '--no-build', '--force-recreate', 'istra']),
      )
    },

    async activateClients() {
      if (!prepared) throw new Error('Packaged clients were not prepared')
      let codexActivated = false
      const restoreCodex = async (): Promise<void> => {
        if (!prepared || !codexActivated) return
        const failedSource = `${config.codexPluginSource}.failed.${config.deploymentId}`
        if (await pathExists(config.codexPluginSource)) await rename(config.codexPluginSource, failedSource)
        if (!await pathExists(prepared.codexPrevious)) throw new Error('Codex rollback package is missing')
        await rename(prepared.codexPrevious, config.codexPluginSource)
        await command(
          runner,
          config,
          baseEnvironment,
          'codex.restore-previous',
          'codex',
          ['plugin', 'add', `istra@${config.codexMarketplace}`, '--json'],
        )
        codexActivated = false
      }
      await rename(config.codexPluginSource, prepared.codexPrevious)
      try {
        await rename(prepared.codexStage, config.codexPluginSource)
        await command(
          runner,
          config,
          baseEnvironment,
          'codex.install',
          'codex',
          ['plugin', 'add', `istra@${config.codexMarketplace}`, '--json'],
        )
        const installed = await command(
          runner,
          config,
          baseEnvironment,
          'codex.verify-install',
          'codex',
          ['plugin', 'list', '--marketplace', config.codexMarketplace, '--json'],
        )
        const listing = parseJson<{ installed?: Array<{ pluginId?: unknown; version?: unknown }> }>(installed.stdout, 'Codex verification')
        const plugin = listing.installed?.find((entry) => entry.pluginId === `istra@${config.codexMarketplace}`)
        if (plugin?.version !== prepared.codexVersion) throw new Error('Codex did not install the prepared Istra version')
        const cachePath = join(config.codexPluginCacheRoot, prepared.codexVersion)
        await assertMatchingFile(join(builtPluginRoot, 'dist', 'server.mjs'), join(cachePath, 'dist', 'server.mjs'), 'Installed Codex server runtime')
        await assertMatchingFile(join(builtPluginRoot, 'dist', 'mcp', 'stdio.mjs'), join(cachePath, 'dist', 'mcp', 'stdio.mjs'), 'Installed Codex MCP runtime')
        codexActivated = true
      } catch (error) {
        const failedSource = `${config.codexPluginSource}.failed.${config.deploymentId}`
        if (await pathExists(config.codexPluginSource)) await rename(config.codexPluginSource, failedSource)
        if (await pathExists(prepared.codexPrevious)) {
          await rename(prepared.codexPrevious, config.codexPluginSource)
          await command(
            runner,
            config,
            baseEnvironment,
            'codex.restore-previous',
            'codex',
            ['plugin', 'add', `istra@${config.codexMarketplace}`, '--json'],
          )
        }
        throw error
      }

      await mkdir(dirname(config.opencodeLoader), { recursive: true, mode: 0o700 })
      const opencodeLoaderExisted = await pathExists(config.opencodeLoader)
      if (opencodeLoaderExisted) await copyFile(config.opencodeLoader, prepared.opencodeLoaderPrevious)
      const loader = `export { default } from ${JSON.stringify(pathToFileURL(join(prepared.opencodePackagePath, 'dist', 'server.mjs')).href)};\n`
      try {
        await writeAtomic(config.opencodeLoader, loader, 0o600)
        const listed = await command(runner, config, baseEnvironment, 'opencode.verify-install', 'opencode', ['mcp', 'list'])
        const normalised = stripAnsi(`${listed.stdout}\n${listed.stderr}`).toLowerCase()
        if (!normalised.includes('istra') || !normalised.includes('connected')) {
          throw new Error('OpenCode did not report the prepared Istra MCP as connected')
        }
      } catch (error) {
        await restoreOpenCodeLoader(config.opencodeLoader, prepared.opencodeLoaderPrevious, opencodeLoaderExisted)
        try {
          await restoreCodex()
        } catch (restoreError) {
          const activationMessage = error instanceof Error ? error.message : 'OpenCode activation failed'
          const restoreMessage = restoreError instanceof Error ? restoreError.message : 'Codex rollback failed'
          throw new Error(`${activationMessage}; Codex rollback also failed: ${restoreMessage}`)
        }
        throw error
      }
      clientsActivated = true
    },

    async verifyDeployment() {
      const readyUrl = new URL('/api/v1/ready', config.healthBaseUrl)
      const storageUrl = new URL('/api/v1/storage', config.healthBaseUrl)
      await command(runner, config, baseEnvironment, 'runtime.ready', 'curl', ['--silent', '--show-error', '--fail', readyUrl.href])
      const storage = await command(runner, config, baseEnvironment, 'runtime.storage', 'curl', ['--silent', '--show-error', '--fail', storageUrl.href])
      assertStorageStatus(storage.stdout, config.productionDatabase, 'Runtime storage endpoint')
    },

    async restartUnchangedProduction() {
      await command(runner, config, baseEnvironment, 'production.restart-unchanged', 'docker', composeArguments(config, ['start', '--wait', 'istra']))
    },

    async cleanupTrial() {
      assertSafeTrialDatabase(config.trialDatabase, config.productionDatabase)
      await command(
        runner,
        config,
        baseEnvironment,
        'trial.drop',
        'dropdb',
        ['--if-exists', '--force', config.trialDatabase],
        productionPgEnvironment,
      )
    },
  }

  try {
    await executeTrialFirstWorkflow(phases)
    deploymentSucceeded = true
    console.log(`Deployment verified. Backup: ${backupPath}`)
    console.log(`Backup SHA-256: ${backupDigest}`)
    console.log(`Rollback image: ${rollbackImage}`)
    console.log('Restart OpenCode and start a new Codex task before using the refreshed MCP clients.')
    return {
      backupPath,
      backupDigest,
      codexVersion: prepared!.codexVersion,
      opencodePackagePath,
      rollbackImage,
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
    if (!deploymentSucceeded) {
      if (await pathExists(codexStage)) await rm(codexStage, { recursive: true })
      if (!clientsActivated && await pathExists(opencodePackagePath)) await rm(opencodePackagePath, { recursive: true })
    }
    if (lockAcquired) await rm(lockDirectory, { recursive: true })
    process.umask(previousUmask)
  }
}

function usage(): string {
  return `Usage:
  pnpm deploy:production -- --env-file /absolute/path/.env --confirm-target postgresql://127.0.0.1:5433/istra --backup-dir /absolute/backup/path
  pnpm deploy:production -- --apply --env-file /absolute/path/.env --confirm-target postgresql://127.0.0.1:5433/istra --backup-dir /absolute/backup/path

The default is a read-only dry run. The pinned mode-0600 env file is parsed by Node and is never executed as shell code.
See docs/operations.md for the maintenance window, client restarts, failure handling, and rollback.`
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2)
    if (parseArguments(argv).has('--help')) {
      console.log(usage())
      return
    }
    await loadPinnedEnvironmentFile(argv)
    const config = createDeploymentConfig(argv)
    await runDeployment(config)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown deployment failure'
    console.error(`Deployment stopped: ${message}`)
    console.error('No automatic production restore was attempted. Follow the guarded recovery procedure in docs/operations.md.')
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) await main()
