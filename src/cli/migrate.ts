import { createRuntime } from '../infrastructure/runtime.js'

const runtime = await createRuntime()
console.log(`Istra database is migrated: ${runtime.paths.databasePath}`)
runtime.close()
