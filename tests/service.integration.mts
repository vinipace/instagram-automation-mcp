import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { neon } from '@neondatabase/serverless'
import { localEnv } from '../scripts/local-env.mts'
import {
  type Comment,
  type Env,
  type EventRecord,
  ruleDefinitionSchema,
  secondsNow,
} from '../src/domain.mts'
import { processJob, publishPending } from '../src/processor.mts'
import { Store } from '../src/store.mts'
import { createWorker } from '../src/worker.mts'

const config = await localEnv()
const databaseUrl = config.TEST_DATABASE_URL
if (!databaseUrl)
  throw new Error(
    'Set an explicit TEST_DATABASE_URL for integration tests; DATABASE_URL is production',
  )
const schema = `ig_test_${crypto.randomUUID().replaceAll('-', '')}`
const account = 'integration_account'
const store = new Store(databaseUrl, account, schema)
const sql = neon(databaseUrl)
const now = secondsNow()
const token = `integration-only-${'a'.repeat(32)}`
const jobs: string[] = []
const env = {
  DATABASE_URL: databaseUrl,
  IG_ACCOUNT_ID: account,
  META_API_VERSION: 'v99.0',
  META_APP_SECRET: 'integration-secret',
  META_ACCESS_TOKEN: 'integration-only',
  META_VERIFY_TOKEN: 'integration-verify',
  MCP_ADMIN_TOKEN: token,
  MCP_READ_TOKEN: `reader-${'r'.repeat(32)}`,
  LIVE_SENDS: 'true',
  RETENTION_DAYS: '30',
  REPLIES: {
    send: async (job: { eventId: string }) => {
      jobs.push(job.eventId)
    },
  },
} as unknown as Env
let counter = 0
function comment(text: string, user?: string, timestamp = now): Comment {
  counter++
  return {
    accountId: account,
    commentId: `comment_${counter}`,
    commenterId: user ?? `person_${counter}`,
    mediaId: 'reel',
    text,
    timestamp,
  }
}
async function readyRule(keyword: string, cooldownSeconds = 86400) {
  const definition = ruleDefinitionSchema.parse({
    name: keyword,
    keywords: [keyword],
    scope: { kind: 'selected', mediaIds: ['reel'] },
    replyText: `${keyword} approved response`,
    cooldownSeconds,
  })
  const disabled = await store.createRule(definition, 'integration', now)
  return store.updateRule(disabled.id, 1, null, true, 'integration', now)
}
async function addComment(c: Comment) {
  await store.acceptComments([c], now)
  return `${account}:${c.commentId}`
}
function acceptedFetcher(
  onSend: (init: RequestInit | undefined) => void = () => {},
): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    onSend(init)
    return Response.json({
      message_id: `receipt_${counter}`,
      recipient_id: 'test_recipient',
    })
  }) as typeof fetch
}
before(async () => {
  const migration = (await Promise.all(['0001_initial.sql','0002_reliability.sql','0003_public_replies.sql','0004_post_cooldowns.sql'].map(file => readFile(new URL('../migrations/' + file, import.meta.url),'utf8')))).join('\n').replaceAll('instagram_automation', schema)
  try {
    await sql.transaction(
      migration
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => sql.query(s)),
    )
  } catch {
    throw new Error(
      'Cannot initialize the isolated integration-test schema; verify test database connectivity',
    )
  }
  await store.setPaused(false, 1, 'integration', now)
})
after(async () => {
  // Only the random schema created by this test run is removed; never production/application tables.
  await sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
})
test('duplicate webhook deliveries and concurrent queue consumers produce one provider call', async () => {
  await readyRule('DUPLICATE')
  const c = comment('duplicate')
  const results = await Promise.all(
    Array.from({ length: 5 }, () => store.acceptComments([c], now)),
  )
  assert.equal(
    results.reduce((sum, r) => sum + r.inserted, 0),
    1,
  )
  let calls = 0
  const id = `${account}:${c.commentId}`
  await Promise.all(
    Array.from({ length: 8 }, () =>
      processJob(
        store,
        env,
        { eventId: id },
        acceptedFetcher(() => {
          calls++
        }),
        () => now,
      ),
    ),
  )
  assert.equal(calls, 1)
  const event = await store.getEvent(id)
  assert.equal(event.state, 'provider_accepted')
  assert.ok(event.provider_message_id)
})
test('pending work keeps the approved response after an active-rule edit; revisions reject stale writes', async () => {
  const rule = await readyRule('SNAPSHOT')
  const id = await addComment(comment('snapshot'))
  const edited = { ...rule.definition, replyText: 'New response' }
  await store.updateRule(
    rule.id,
    rule.revision,
    edited,
    null,
    'integration',
    now,
  )
  await assert.rejects(
    store.updateRule(rule.id, rule.revision, edited, null, 'integration', now),
    /revision conflict/,
  )
  let text = ''
  await processJob(
    store,
    env,
    { eventId: id },
    acceptedFetcher((init) => {
      text = JSON.parse(String(init?.body)).message.text
    }),
    () => now,
  )
  assert.equal(text, 'SNAPSHOT approved response')
  assert.equal((await store.getEvent(id)).rule_revision, rule.revision)
  assert.equal((await store.ruleHistory(rule.id, 100, 9999)).length, 3)
})
test('account pause holds pending jobs, and disable atomically cancels them', async () => {
  const rule = await readyRule('PAUSE')
  const id = await addComment(comment('pause'))
  let calls = 0
  const settings = await store.settings()
  await store.setPaused(true, settings.revision, 'integration', now)
  await processJob(
    store,
    env,
    { eventId: id },
    acceptedFetcher(() => {
      calls++
    }),
    () => now,
  )
  assert.equal(calls, 0)
  assert.equal((await store.getEvent(id)).state, 'pending')
  await store.updateRule(
    rule.id,
    rule.revision,
    null,
    false,
    'integration',
    now,
  )
  assert.equal((await store.getEvent(id)).state, 'canceled')
  const paused = await store.settings()
  await store.setPaused(false, paused.revision, 'integration', now)
  await processJob(
    store,
    env,
    { eventId: id },
    acceptedFetcher(() => {
      calls++
    }),
    () => now,
  )
  assert.equal(calls, 0)
})
test('contact cooldown is atomic across different simultaneous comments', async () => {
  await readyRule('COOLDOWN')
  const [a, b] = await Promise.all([
    addComment(comment('cooldown', 'same_person')),
    addComment(comment('cooldown', 'same_person')),
  ])
  let calls = 0
  await Promise.all(
    [a, b].map((eventId) =>
      processJob(
        store,
        env,
        { eventId },
        acceptedFetcher(() => {
          calls++
        }),
        () => now,
      ),
    ),
  )
  assert.equal(calls, 1)
  const states = [
    (await store.getEvent(a)).state,
    (await store.getEvent(b)).state,
  ].sort()
  assert.deepEqual(states, ['provider_accepted', 'skipped'])
})
test('a pause between claiming and sending keeps the job pending for resume', async () => {
  await readyRule('PAUSE-RACE')
  const id = await addComment(comment('pause-race'))
  const originalEligibility = store.sendEligibility.bind(store)
  store.sendEligibility = async (event, time) => {
    const current = await store.settings()
    await store.setPaused(true, current.revision, 'integration', time)
    return originalEligibility(event, time)
  }
  let calls = 0
  try {
    await processJob(
      store,
      env,
      { eventId: id },
      acceptedFetcher(() => {
        calls++
      }),
      () => now,
    )
  } finally {
    store.sendEligibility = originalEligibility
  }
  assert.equal(calls, 0)
  assert.equal((await store.getEvent(id)).state, 'retry')
  const paused = await store.settings()
  await store.setPaused(false, paused.revision, 'integration', now)
  await processJob(
    store,
    env,
    { eventId: id },
    acceptedFetcher(() => {
      calls++
    }),
    () => now,
  )
  assert.equal(calls, 1)
})
test('queue-publication failures are durable and recoverable', async () => {
  await readyRule('OUTBOX')
  const id = await addComment(comment('outbox'))
  const broken = {
    ...env,
    REPLIES: {
      send: async () => {
        throw new Error('queue unavailable')
      },
    },
  } as unknown as Env
  await publishPending(store, broken, now)
  assert.equal((await store.getEvent(id)).reason, 'queue_publish_failed')
  assert.equal((await store.getEvent(id)).queued_at, null)
  await store.recover(now + 61, 30)
  await publishPending(store, env, now + 61)
  assert.ok(jobs.includes(id))
  await processJob(
    store,
    env,
    { eventId: id },
    acceptedFetcher(),
    () => now + 61,
  )
  assert.equal((await store.getEvent(id)).state, 'provider_accepted')
})
test('manual recovery of a safely rejected event is audited; DLQ cannot relabel an uncertain send', async () => {
  await readyRule('PERMISSION')
  const id = await addComment(comment('permission'))
  const rejected = (async () =>
    Response.json({ error: { code: 190 } }, { status: 401 })) as typeof fetch
  await processJob(store, env, { eventId: id }, rejected, () => now)
  assert.equal((await store.getEvent(id)).state, 'blocked')
  await store.retryEvent(id, 'operator', now + 1)
  const audit = (await store.eventOperations(id)) as {
    operation: string
    actor: string
  }[]
  assert.equal(audit[0].operation, 'retry')
  assert.equal(audit[0].actor, 'operator')
  await processJob(
    store,
    env,
    { eventId: id },
    acceptedFetcher(),
    () => now + 1,
  )
  assert.equal((await store.getEvent(id)).state, 'provider_accepted')
  const uncertainId = await addComment(comment('permission'))
  await processJob(
    store,
    env,
    { eventId: uncertainId },
    (async () => {
      throw new Error('lost')
    }) as typeof fetch,
    () => now,
  )
  await store.deadLetter(uncertainId, now + 1)
  assert.equal((await store.getEvent(uncertainId)).state, 'send_unknown')
})
test('explicit rate-limit rejection retries later, while timeout remains uncertain and cannot be retried', async () => {
  await readyRule('RETRY')
  const id = await addComment(comment('retry'))
  const limited = (async () =>
    Response.json(
      { error: { code: 4 } },
      { status: 429, headers: { 'Retry-After': '120' } },
    )) as typeof fetch
  await processJob(store, env, { eventId: id }, limited, () => now)
  assert.equal((await store.getEvent(id)).state, 'retry')
  let calls = 0
  await processJob(
    store,
    env,
    { eventId: id },
    acceptedFetcher(() => {
      calls++
    }),
    () => now + 60,
  )
  assert.equal(calls, 0)
  await processJob(
    store,
    env,
    { eventId: id },
    acceptedFetcher(() => {
      calls++
    }),
    () => now + 121,
  )
  assert.equal(calls, 1)
  await assert.rejects(store.retryEvent(id, 'integration', now + 122))
  const timeoutId = await addComment(comment('retry'))
  const timeout = (async () => {
    throw new Error('network timeout')
  }) as typeof fetch
  await processJob(store, env, { eventId: timeoutId }, timeout, () => now)
  assert.equal((await store.getEvent(timeoutId)).state, 'send_unknown')
  await processJob(
    store,
    env,
    { eventId: timeoutId },
    acceptedFetcher(() => {
      calls++
    }),
    () => now + 180,
  )
  assert.equal(calls, 1)
  await assert.rejects(store.retryEvent(timeoutId, 'integration', now + 180))
})
test('expired comments, live-send kill switch, and abandoned send claims never cause a blind send', async () => {
  await readyRule('EXPIRY')
  const expired = await addComment(
    comment('expiry', undefined, now - 7 * 86400),
  )
  assert.equal((await store.getEvent(expired)).reason, 'comment_expired')
  const id = await addComment(comment('expiry'))
  let calls = 0
  await processJob(
    store,
    { ...env, LIVE_SENDS: 'false' },
    { eventId: id },
    acceptedFetcher(() => {
      calls++
    }),
    () => now,
  )
  assert.equal(calls, 0)
  await store.claim(id, crypto.randomUUID(), now)
  await store.recover(now + 91, 30)
  assert.equal((await store.getEvent(id)).state, 'send_unknown')
  await processJob(
    store,
    env,
    { eventId: id },
    acceptedFetcher(() => {
      calls++
    }),
    () => now + 92,
  )
  assert.equal(calls, 0)
})
test('signed webhook → real Postgres intent → mocked provider receipt → MCP event inspection works end to end', async () => {
  await readyRule('WEBHOOK')
  const c = comment('webhook')
  const body = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: account,
        time: now,
        changes: [
          {
            field: 'comments',
            value: {
              id: c.commentId,
              text: c.text,
              from: { id: c.commenterId },
              media: { id: c.mediaId },
            },
          },
        ],
      },
    ],
  })
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.META_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature =
    'sha256=' +
    Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
    ).toString('hex')
  const deferred: Promise<unknown>[] = []
  const worker = createWorker(() => store, acceptedFetcher())
  const ctx = {
    waitUntil: (work: Promise<unknown>) => {
      deferred.push(work)
    },
  }
  const response = await worker.fetch(
    new Request('https://worker.test/webhooks/instagram', {
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': signature },
    }),
    env,
    ctx,
  )
  assert.equal(response.status, 200)
  await Promise.all(deferred)
  const id = `${account}:${c.commentId}`
  assert.ok(jobs.includes(id))
  let ack = false
  await worker.queue(
    {
      queue: 'replies',
      messages: [
        {
          body: { eventId: id },
          attempts: 1,
          ack() {
            ack = true
          },
          retry() {},
        },
      ],
    } as unknown as MessageBatch<{ eventId: string }>,
    env,
  )
  assert.equal(ack, true)
  const mcp = await worker.fetch(
    new Request('https://worker.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_event', arguments: { eventId: id } },
      }),
    }),
    env,
    ctx,
  )
  assert.equal(mcp.status, 200)
  const result = (await mcp.json()) as {
    result: { structuredContent: { data: { event: EventRecord } } }
  }
  assert.equal(
    result.result.structuredContent.data.event.state,
    'provider_accepted',
  )
})
test('MCP reader can inspect but cannot discover or invoke mutation tools', async () => {
  const worker = createWorker(() => store)
  const request = (method: string, params: unknown = {}) =>
    new Request('https://worker.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MCP_READ_TOKEN}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  const result = (await (
    await worker.fetch(request('tools/list'), env, { waitUntil() {} })
  ).json()) as { result: { tools: { name: string }[] } }
  const names = result.result.tools.map((tool) => tool.name)
  assert.ok(names.includes('get_health'))
  assert.ok(!names.includes('create_rule'))
  assert.ok(!names.includes('resume_account'))
  const denied = (await (
    await worker.fetch(
      request('tools/call', {
        name: 'pause_account',
        arguments: { expectedRevision: 1 },
      }),
      env,
      { waitUntil() {} },
    )
  ).json()) as { result?: { isError?: boolean }; error?: unknown }
  assert.ok(denied.error || denied.result?.isError)
})
