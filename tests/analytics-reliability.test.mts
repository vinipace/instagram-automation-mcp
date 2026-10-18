import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type Env } from '../src/domain.mts'
import { Store } from '../src/store.mts'
import { accountInsights, analyticsWindow, mediaInsights, normalizeMetric } from '../src/analytics.mts'
import { type Credential, activeToken, decryptToken, encryptToken, refreshCredential, tokenMetadata } from '../src/credentials.mts'
import { providerGet } from '../src/provider.mts'
import { checkConnection, reliabilityAlerts } from '../src/reliability.mts'
import { createWorker } from '../src/worker.mts'

const env = { IG_ACCOUNT_ID: 'webhook-id', META_API_VERSION: 'v26.0', META_ACCESS_TOKEN: 'original-token-long-enough', META_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) } as unknown as Env
const now = 1700000000
const account = { id: 'app-scoped-id', user_id: env.IG_ACCOUNT_ID, username: 'test-owner', account_type: 'BUSINESS' }
const fetcher = (handler: (url: string) => Response | Promise<Response>) => (async (url: unknown, init?: RequestInit) => {
  assert.equal(init?.method, 'GET')
  assert.equal(init?.redirect, 'manual')
  assert.ok(String(init?.headers && (init.headers as Record<string, string>).Authorization).startsWith('Bearer '))
  return handler(String(url))
}) as typeof fetch

test('analytics distinguish zero, unavailable data and provider errors without leaking pagination tokens', async () => {
  assert.equal(normalizeMetric({ data: [{ name: 'views', period: 'day', total_value: { value: 0 } }], paging: { next: 'https://bad/?access_token=secret' } }, 'views').total, 0)
  assert.equal(normalizeMetric({ data: [] }, 'views').availability, 'unavailable')
  const response = await accountInsights(env, 'test-only', ['views','reach','likes'], { since: now - 86400, until: now }, fetcher(url => {
    const u = new URL(url)
    if (u.pathname.endsWith('/me')) return Response.json(account)
    if (u.searchParams.get('metric') === 'likes') return Response.json({ error: { code: 10, message: 'secret should never escape' } }, { status: 403 })
    return Response.json({ data: [{ name: u.searchParams.get('metric'), period: 'day', total_value: { value: 0 } }], paging: { next: 'https://bad/secret' } })
  }))
  assert.equal(response.metrics[0].total, 0)
  assert.equal(response.metrics[2].reason, 'permission_or_token')
  assert.ok(!JSON.stringify(response).includes('secret'))
  assert.throws(() => analyticsWindow(now, now + 1, now), /past positive/)
  assert.throws(() => analyticsWindow(now - 32 * 86400, now, now), /31 days/)
})
test('media ownership accepts the app-scoped owner but refuses a foreign media before requesting insights', async () => {
  for (const foreign of [false, true]) {
    let insightCalls = 0
    const run = () => mediaInsights(env, 'test-only', '123', ['views'], fetcher(url => {
      if (url.endsWith('insights?metric=views')) { insightCalls++; return Response.json({ data: [{ name: 'views', period: 'lifetime', values: [{ value: 123 }] }] }) }
      if (new URL(url).pathname.endsWith('/me')) return Response.json(account)
      return Response.json({ id: '123', owner: { id: foreign ? 'someone-else' : account.id }, media_type: 'VIDEO', media_product_type: 'REELS' })
    }))
    if (foreign) { await assert.rejects(run, /must belong/); assert.equal(insightCalls, 0) }
    else { assert.equal((await run()).metrics[0].values[0].value, 123); assert.equal(insightCalls, 1) }
  }
})
test('provider redirects, oversized responses and raw errors never forward or expose credentials', async () => {
  let calls = 0
  await assert.rejects(() => providerGet(env, 'secret-bearer', 'me', {}, fetcher(() => {
    calls++; return Response.json({}, { status: 302, headers: { Location: 'https://foreign.example/' } })
  })), /unavailable/)
  assert.equal(calls, 1)
  await assert.rejects(() => providerGet(env, 'secret-bearer', 'me', {}, fetcher(() => new Response('x'.repeat(300000)))), /unavailable/)
  await assert.rejects(() => providerGet(env, 'secret-bearer', 'me', {}, fetcher(() => Response.json({ error: { code: 190, message: 'secret-bearer' } }, { status: 400 }))), error => String(error).includes('190') && !String(error).includes('secret-bearer'))
})
test('encrypted credentials bind to the account and fail closed on tampering or loss of the stored credential', async () => {
  const encrypted = await encryptToken('secret-token', env.META_TOKEN_ENCRYPTION_KEY!, env.IG_ACCOUNT_ID)
  assert.ok(!encrypted.includes('secret-token'))
  assert.equal(await decryptToken(encrypted, env.META_TOKEN_ENCRYPTION_KEY!, env.IG_ACCOUNT_ID), 'secret-token')
  await assert.rejects(() => decryptToken(encrypted, env.META_TOKEN_ENCRYPTION_KEY!, 'other-account'), /could not be loaded/)
  await assert.rejects(() => decryptToken(encrypted.slice(0,-4), env.META_TOKEN_ENCRYPTION_KEY!, env.IG_ACCOUNT_ID), /could not be loaded/)
  const empty = { accountId: env.IG_ACCOUNT_ID, rows: async () => [] } as unknown as Store
  await assert.rejects(() => activeToken(env, empty), /Initialize/)
})

async function renewalStore(eligible: boolean) {
  const record: Credential = { account_id: env.IG_ACCOUNT_ID, ciphertext: await encryptToken(env.META_ACCESS_TOKEN!, env.META_TOKEN_ENCRYPTION_KEY!, env.IG_ACCOUNT_ID), revision: 1, stored_at: now - 86400, expires_at: null, refresh_not_before: eligible ? now - 1 : now + 86400, next_refresh_at: now, refreshed_at: null, refresh_claim: null, refresh_lease_until: 0, last_refresh_error: null, last_refresh_error_at: null }
  const original = record.ciphertext
  const store = { accountId: env.IG_ACCOUNT_ID, rows: async (query: string, values: unknown[]) => {
    if (query.startsWith('SELECT *')) return [{ ...record }]
    if (query.startsWith('UPDATE')) {
      if (!eligible || record.refresh_claim) return []
      record.refresh_claim = String(values[1]); return [{ ...record }]
    }
    if (query.includes('ciphertext = $3')) {
      assert.equal(values[1], record.refresh_claim)
      assert.equal(values[6], 1)
      record.ciphertext = String(values[2]); record.revision++; record.expires_at = Number(values[3]); record.refreshed_at = now; record.next_refresh_at = Number(values[5]); record.refresh_claim = null
      return [{ ...record }]
    }
    if (query.includes('last_refresh_error = $4')) { record.last_refresh_error = String(values[3]); record.refresh_claim = null; return [{ account_id: record.account_id }] }
    throw Error('Unexpected store operation')
  } } as unknown as Store
  return { store, record, original }
}
test('token renewal waits 24 hours, serializes concurrent attempts, verifies account and persists only encrypted output', async () => {
  const young = await renewalStore(false)
  let calls = 0
  const mock = fetcher(url => {
    calls++
    return new URL(url).pathname === '/refresh_access_token' ? Response.json({ access_token: 'refreshed-token-long-enough', token_type: 'bearer', expires_in: 60 * 86400 }) : Response.json(account)
  })
  assert.equal((await refreshCredential(env, young.store, 'owner', now, false, mock)).outcome, 'deferred')
  assert.equal(calls, 0)
  const ready = await renewalStore(true)
  const results = await Promise.all([refreshCredential(env, ready.store, 'owner', now, false, mock), refreshCredential(env, ready.store, 'owner', now, false, mock)])
  assert.deepEqual(results.map(r => r.outcome).sort(), ['deferred','refreshed'])
  assert.equal(calls, 2)
  assert.equal(ready.record.expires_at, now + 60 * 86400)
  assert.equal(ready.record.next_refresh_at, now + 53 * 86400)
  assert.equal(await decryptToken(ready.record.ciphertext, env.META_TOKEN_ENCRYPTION_KEY!, env.IG_ACCOUNT_ID), 'refreshed-token-long-enough')
  assert.ok(!JSON.stringify(results).includes('refreshed-token-long-enough'))
})
test('wrong-account refreshed tokens and provider rejection preserve the existing credential', async () => {
  for (const rejected of [false, true]) {
    const { store, record, original } = await renewalStore(true)
    await assert.rejects(() => refreshCredential(env, store, 'owner', now, false, fetcher(url => {
      if (new URL(url).pathname === '/refresh_access_token') return rejected ? Response.json({ error: { code: 190 } }, { status: 400 }) : Response.json({ access_token: 'wrong-account-token-long-enough', token_type: 'bearer', expires_in: 60 * 86400 })
      return Response.json({ ...account, user_id: 'foreign' })
    })), /token renewal failed/)
    assert.equal(record.ciphertext, original)
    assert.ok(record.last_refresh_error)
  }
})
test('real connection checks reject mismatched tokens and alerts distinguish retained failures from uncertain sends', async () => {
  const noKey = { ...env, META_TOKEN_ENCRYPTION_KEY: undefined }
  const store = {} as Store
  assert.equal((await checkConnection(noKey, store, now, fetcher(() => Response.json({ ...account, user_id: 'wrong' })))).connection, 'failed')
  assert.equal((await checkConnection(noKey, store, now, fetcher(url => Response.json(new URL(url).pathname.endsWith('/me') ? account : { data: [{ subscribed_fields: ['comments'] }] })))).connection, 'verified')
  const alerts = reliabilityAlerts({ paused: false, last_recovery_at: now }, [{ state: 'failed', count: 10, oldest_age_seconds: 900, oldest_received_at: now - 900 }], tokenMetadata(null, now), now)
  assert.equal(alerts.length, 0)
  assert.equal(reliabilityAlerts({ paused: false, last_recovery_at: now }, [{ state: 'retry', count: 1, oldest_age_seconds: 900, oldest_received_at: now - 900, oldest_actionable_age_seconds: -60 }, { state: 'sending', count: 1, oldest_age_seconds: 900, oldest_received_at: now - 900, oldest_actionable_age_seconds: 1 }], tokenMetadata(null, now), now).length, 0)
  assert.equal(reliabilityAlerts({ paused: true, last_recovery_at: now }, [{ state: 'send_unknown', count: 1, oldest_age_seconds: 10, oldest_received_at: now - 10 }], tokenMetadata(null, now), now)[0].code, 'uncertain_send_requires_review')
})
test('hosted MCP protocol exposes exactly eight new tools and keeps token renewal unavailable to readers', async () => {
  const reader = 'reader-' + 'r'.repeat(32)
  const admin = 'admin-' + 'a'.repeat(32)
  const local = { ...env, META_TOKEN_ENCRYPTION_KEY: undefined, MCP_ADMIN_TOKEN: admin, MCP_READ_TOKEN: reader, DATABASE_URL: 'test-only', META_APP_SECRET: 'test-only', META_VERIFY_TOKEN: 'test-only', REPLIES: {}, LIVE_SENDS: 'true' } as Env
  const fakeStore = {
    accountId: env.IG_ACCOUNT_ID,
    settings: async () => ({ paused: false, revision: 6, last_recovery_at: Math.floor(Date.now()/1000) }),
    backlog: async () => [],
    publicBacklog: async () => [],
    rows: async () => [{ eligible: 0, queue_publish_failures: 0, dead_lettered: 0 }],
  } as unknown as Store
  let metaCalls = 0
  const worker = createWorker(() => fakeStore, fetcher(url => {
    metaCalls++
    return Response.json(new URL(url).pathname.endsWith('/me') ? account : { data: [{ subscribed_fields: ['comments'] }] })
  }))
  const transportFetch: typeof fetch = async (input, init) => worker.fetch(new Request(input instanceof Request ? input : String(input), init), local, { waitUntil: () => {} })
  for (const [token, count] of [[admin, 24], [reader, 16]] as const) {
    const client = new Client({ name: 'test-only', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('https://test.local/mcp'), { fetch: transportFetch, requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
      const catalog = await client.listTools()
      assert.equal(catalog.tools.length, count)
      assert.ok(catalog.tools.find(t => t.name === 'get_account_insights')?.annotations?.readOnlyHint)
      assert.equal(catalog.tools.some(t => t.name === 'refresh_token'), token === admin)
      const health = await client.callTool({ name: 'get_health', arguments: {} })
      assert.equal((health.structuredContent as { data: { providerConnection: string } }).data.providerConnection, 'verified')
      const before = metaCalls
      if (token === reader) {
        const denied = await client.callTool({ name: 'refresh_token', arguments: {} })
        assert.ok(denied.isError)
        assert.equal(metaCalls, before)
      }
    } finally { await client.close() }
  }
})
test('queue consumers use the durable credential and fail before claiming when it is missing; dead letters do not require a token', async () => {
  const encrypted = await encryptToken('durable-token', env.META_TOKEN_ENCRYPTION_KEY!, env.IG_ACCOUNT_ID)
  for (const missing of [false, true]) {
    let claims = 0, accepted = 0, sends = 0, deadLetters = 0
    const fakeStore = {
      rows: async () => missing ? [] : [{ ciphertext: encrypted }],
      claim: async () => { claims++; return { comment_id: 'comment-test', reply_text: 'TEST', attempts: 1, max_attempts: 5, expires_at: now + 60 } },
      sendEligibility: async () => 'ready',
      finish: async (_event: unknown, outcome: { state: string }) => { assert.equal(outcome.state, 'provider_accepted'); accepted++ },
      deadLetter: async () => { deadLetters++ },
    } as unknown as Store
    const local = { ...env, META_APP_SECRET: 'test-only', LIVE_SENDS: 'true', DLQ_NAME: 'failed-jobs' }
    const worker = createWorker(() => fakeStore, (async (_url, init) => {
      sends++
      assert.equal((init!.headers as Record<string,string>).Authorization, 'Bearer durable-token')
      return Response.json({ message_id: 'receipt-test', recipient_id: 'recipient-test' })
    }) as typeof fetch)
    const batch = { queue: 'replies', messages: [{ body: { eventId: 'event-test' }, ack: () => {}, retry: () => { throw Error('unexpected retry') } }] } as unknown as MessageBatch<{ eventId: string }>
    if (missing) { await assert.rejects(() => worker.queue(batch, local), /Initialize/); assert.equal(claims, 0); assert.equal(sends, 0) }
    else { await worker.queue(batch, local); assert.equal(claims, 1); assert.equal(accepted, 1); assert.equal(sends, 1) }
    await worker.queue({ ...batch, queue: 'failed-jobs' }, local)
    assert.equal(deadLetters, 1)
  }
})
