import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { localEnv } from './local-env.mts'

const env = await localEnv()
const endpoint = env.MCP_TEST_URL || 'http://127.0.0.1:8789/mcp'
if (!env.MCP_ADMIN_TOKEN)
  throw new Error('Set MCP_ADMIN_TOKEN in .dev.vars for the smoke check')
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${env.MCP_ADMIN_TOKEN}` } },
})
const client = new Client({
  name: 'instagram-automation-smoke',
  version: '0.1.0',
})
try {
  await client.connect(transport)
  const tools = await client.listTools()
  assert.equal(tools.tools.length, 24)
  const result = await client.callTool({ name: 'get_health', arguments: {} })
  assert.ok(!result.isError)
  const health = (
    result.structuredContent as {
      data: {
        database: string
        liveSends: boolean
        account: { paused: boolean }
      }
    }
  ).data
  assert.equal(health.database, 'reachable')
  console.log(
    JSON.stringify({
      connected: true,
      tools: tools.tools.length,
      database: health.database,
      paused: health.account.paused,
      liveSends: health.liveSends,
    }),
  )
} catch {
  console.error(
    'MCP smoke check failed. Confirm the Worker is running and the local bearer token is configured.',
  )
  process.exitCode = 1
} finally {
  await client.close()
}
