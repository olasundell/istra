import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createRuntime } from '../../infrastructure/runtime.js'
import { captureMcpRuntimeInfo } from './runtime-info.js'
import { createMcpServer } from './server.js'

const runtimeInfo = await captureMcpRuntimeInfo(new URL(import.meta.url))
const runtime = await createRuntime()
const server = createMcpServer(runtime.service, runtimeInfo)
const transport = new StdioServerTransport()

const close = async () => {
  await server.close()
  await runtime.close()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())

await server.connect(transport)
