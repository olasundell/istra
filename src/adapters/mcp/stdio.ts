import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createRuntime } from '../../infrastructure/runtime.js'
import { createMcpServer } from './server.js'

const runtime = await createRuntime()
const server = createMcpServer(runtime.service)
const transport = new StdioServerTransport()

const close = async () => {
  await server.close()
  runtime.close()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())

await server.connect(transport)
