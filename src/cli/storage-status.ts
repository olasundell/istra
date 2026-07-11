import { createRuntime } from '../infrastructure/runtime.js'

const runtime = await createRuntime()
try {
  console.log(JSON.stringify(await runtime.storageStatus(), null, 2))
} finally {
  await runtime.close()
}
