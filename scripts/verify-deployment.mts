import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { localEnv } from './local-env.mts'

// Read-only verification of a paused cloud deployment. Explicitly choose the
// configured-account expectation only after completing Meta authorization.
const env = await localEnv()
const expectMetaConfigured = process.argv.includes('--meta-configured')
if (!env.MCP_TEST_URL) throw new Error('Set MCP_TEST_URL to your own deployed HTTPS /mcp endpoint')
const endpoint = new URL(env.MCP_TEST_URL)
assert.equal(endpoint.protocol, 'https:')
assert.equal(endpoint.pathname, '/mcp')
assert.ok(
  !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash,
)
assert.ok(env.MCP_ADMIN_TOKEN, 'Configure the local owner token first')

const checkedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  })

const transport = new StreamableHTTPClientTransport(endpoint, {
  fetch: checkedFetch,
  requestInit: { headers: { Authorization: `Bearer ${env.MCP_ADMIN_TOKEN}` } },
})
const client = new Client({
  name: 'instagram-deployment-check',
  version: '0.1.0',
})
let stage = 'public health'
try {
  const healthResponse = await checkedFetch(new URL('/health', endpoint))
  assert.equal(healthResponse.status, 200)
  assert.equal(
    ((await healthResponse.json()) as { status: string }).status,
    'up',
  )

  stage = 'operator privacy notice'
  const privacy = await checkedFetch(new URL('/privacy', endpoint))
  assert.equal(privacy.status, 200, 'Configure the operator name and HTTPS contact before deployment verification')
  await privacy.body?.cancel()

  stage = 'authentication boundaries'
  const rejectedHeaders: Record<string, string>[] = [
    {},
    { Authorization: 'Bearer intentionally-invalid-deployment-check-token' },
    {
      Authorization: `Bearer ${env.MCP_ADMIN_TOKEN}`,
      Origin: 'https://example.invalid',
    },
  ]
  for (const headers of rejectedHeaders) {
    const response = await checkedFetch(endpoint, { headers })
    assert.equal(response.status, 401)
    await response.body?.cancel()
  }

  stage = 'webhook authentication boundary'
  const webhook = await checkedFetch(new URL('/webhooks/instagram', endpoint), {
    method: 'POST',
    body: '{}',
  })
  assert.equal(webhook.status, expectMetaConfigured ? 403 : 503)
  await webhook.body?.cancel()

  stage = 'MCP initialization and tool discovery'
  await client.connect(transport)
  const tools = await client.listTools()
  assert.equal(tools.tools.length, 24)

  stage = 'database and sending gates'
  const result = await client.callTool({ name: 'get_health', arguments: {} })
  assert.ok(!result.isError)
  const health = (
    result.structuredContent as {
      data: {
        asOf: number
        database: string
        liveSends: boolean
        metaConfigured: boolean
        account: { paused: boolean; last_recovery_at: number | null }
      }
    }
  ).data
  assert.equal(health.database, 'reachable')
  assert.equal(health.account.paused, true)
  assert.equal(health.liveSends, false)
  assert.equal(health.metaConfigured, expectMetaConfigured)

  stage = 'recovery schedule'
  const recoveryAgeSeconds =
    health.account.last_recovery_at === null
      ? null
      : health.asOf - health.account.last_recovery_at
  if (process.argv.includes('--require-recovery')) {
    assert.ok(
      recoveryAgeSeconds !== null &&
        recoveryAgeSeconds >= 0 &&
        recoveryAgeSeconds <= 180,
    )
  }

  console.log(
    JSON.stringify({
      endpoint: endpoint.href,
      publicHealth: 'up',
      authentication: 'verified',
      webhook: expectMetaConfigured
        ? 'unsigned_notification_rejected'
        : 'locked_until_meta_setup',
      tools: tools.tools.length,
      database: health.database,
      paused: health.account.paused,
      liveSends: health.liveSends,
      metaConfigured: health.metaConfigured,
      recoveryAgeSeconds,
    }),
  )
} catch {
  // Never print transport errors, headers, or local secrets.
  console.error(`Deployment check failed at: ${stage}`)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
}
