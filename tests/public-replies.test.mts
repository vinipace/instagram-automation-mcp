import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { Store } from '../src/store.mts'
import { ruleDefinitionSchema, type Env, type Job } from '../src/domain.mts'
import { processJob, publishPending } from '../src/processor.mts'
import { queueStatus } from '../src/reliability.mts'

const db = new PGlite()
const schema = 'ig_test_public'
const account = '10000001'
const now = 1700000000
const store = new Store('postgresql://test@localhost/test', account, schema)
interface Query { text: string; values: unknown[] }
// Run the production Store SQL against an isolated in-memory PostgreSQL engine.
// Neon query promises are lazy; preserve that behavior and transaction boundaries.
Object.defineProperty(store, 'sql', { value: {
  query(text: string, values: unknown[] = []) {
    return { text, values, then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
      return db.query(text, values).then(result => ({ rows: result.rows, rowCount: result.affectedRows })).then(resolve, reject)
    } }
  },
  transaction(queries: Query[]) {
    return db.transaction(async tx => {
      const results = []
      for (const query of queries) {
        const result = await tx.query(query.text, query.values)
        results.push({ rows: result.rows, rowCount: result.affectedRows })
      }
      return results
    })
  },
} })
const jobs: Job[] = []
const env = { IG_ACCOUNT_ID: account, LIVE_SENDS: 'true', META_API_VERSION: 'v26.0', META_APP_SECRET: 'test-only', META_ACCESS_TOKEN: 'test-only', REPLIES: { send: async (job: Job) => { jobs.push(job) } } } as unknown as Env
const definition = ruleDefinitionSchema.parse({ name: 'test-only', keywords: ['QUERO'], scope: { kind: 'selected', mediaIds: ['20000001'] }, replyText: 'Private test', publicReplyText: 'Enviei na DM!', cooldownSeconds: 0 })
async function rule(withPublicReply = true) {
  const value = { ...definition }
  if (!withPublicReply) delete value.publicReplyText
  const created = await store.createRule(value, 'test-only', now)
  return store.updateRule(created.id, created.revision, null, true, 'test-only', now)
}
async function event(commentId = '30000001', mediaId = '20000001') {
  await store.acceptComments([{ accountId: account, commentId, commenterId: '40000001', mediaId, text: 'QUERO', timestamp: now }], now)
  return account + ':' + commentId
}
async function acceptDm(id: string) {
  const claimed = await store.claim(id, crypto.randomUUID(), now)
  assert.ok(claimed)
  await store.finish(claimed, { state: 'provider_accepted', reason: 'meta_accepted', messageId: 'private-receipt', recipientId: '40000001' }, now)
  return claimed
}
function fetcher(publicResponse: () => Response | Promise<Response> = () => Response.json({ id: '50000001' })) {
  const calls: { url: string; body: unknown }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    return url.endsWith('/me/messages') ? Response.json({ message_id: 'private-receipt', recipient_id: '40000001' }) : publicResponse()
  }
  return { calls, fetch }
}
before(async () => {
  for (const file of ['0001_initial.sql','0002_reliability.sql','0003_public_replies.sql','0004_post_cooldowns.sql'])
    await db.exec((await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')).replaceAll('instagram_automation', schema))
})
beforeEach(async () => {
  await db.exec('TRUNCATE ' + schema + '.rules,' + schema + '.contact_gates,' + schema + '.post_contact_gates CASCADE')
  await store.rows('UPDATE @schema.account_settings SET paused=FALSE,revision=1,last_recovery_at=$1 WHERE id=1', [now])
  jobs.length = 0
})
after(async () => { await db.close() })

test('authorized trailing-letter reprocessing records one audited intent and sends the snapshotted DM and public reply once', async () => {
  const active = await rule()
  await store.acceptComments([{accountId:account,commentId:'30000001',commenterId:'40000001',mediaId:'20000001',text:'Queroooooo',timestamp:now}],now)
  const id = account + ':30000001', original = await store.getEvent(id)
  assert.equal(original.state,'skipped')
  assert.equal(original.reason,'no_matching_rule')
  assert.equal(original.rule_id,null)
  const updated = await store.updateRule(active.id,active.revision,{...definition,allowTrailingLetterRepeat:true},null,'test-only',now+1)
  const restored = await store.reprocessTrailingLetterComment(id,original.updated_at,'test-only',now+2)
  assert.equal(restored.state,'pending')
  assert.equal(restored.rule_revision,updated.revision)
  assert.equal(restored.reply_text,definition.replyText)
  assert.equal(restored.public_reply_text,definition.publicReplyText)
  assert.equal(restored.attempts,0)
  const operations = await store.eventOperations(id)
  assert.equal(operations.length,1)
  assert.equal((operations[0] as {operation:string}).operation,'reprocess_trailing_letter_repeat:no_matching_rule:zero_dispatch')
  const provider = fetcher()
  await processJob(store,env,{eventId:id},provider.fetch,()=>now+3)
  assert.equal((await store.getEvent(id)).state,'provider_accepted')
  assert.equal((await store.getPublicReply(id)).reply?.state,'provider_accepted')
  assert.equal(provider.calls.length,2)
  await assert.rejects(store.reprocessTrailingLetterComment(id,original.updated_at,'test-only',now+4))
  await processJob(store,env,{eventId:id},provider.fetch,()=>now+4)
  assert.equal(provider.calls.length,2)
})
test('trailing-letter reprocessing rejects disabled matching, stale or expired records and active post cooldowns', async () => {
  const active = await rule()
  await store.acceptComments([{accountId:account,commentId:'30000001',commenterId:'40000001',mediaId:'20000001',text:'Queroooo',timestamp:now}],now)
  const id = account + ':30000001', original = await store.getEvent(id)
  await assert.rejects(store.reprocessTrailingLetterComment(id,original.updated_at,'test-only',now+1))
  await store.updateRule(active.id,active.revision,{...definition,allowTrailingLetterRepeat:true,cooldownSeconds:86400},null,'test-only',now+1)
  await assert.rejects(store.reprocessTrailingLetterComment(id,original.updated_at-1,'test-only',now+2))
  await assert.rejects(store.reprocessTrailingLetterComment(id,original.updated_at,'test-only',original.expires_at))
  const canonical = await event('30000002')
  await acceptDm(canonical)
  await assert.rejects(store.reprocessTrailingLetterComment(id,original.updated_at,'test-only',now+2))
  assert.equal((await store.getEvent(id)).state,'skipped')
  assert.equal((await store.eventOperations(id)).length,0)
  assert.equal((await store.eventAttempts(id)).length,0)
  assert.equal((await store.getPublicReply(id)).reply,null)
})
test('public reply follows a recorded DM receipt and duplicate jobs cannot send twice', async () => {
  await rule()
  const id = await event()
  const provider = fetcher()
  await processJob(store, env, { eventId: id }, provider.fetch, () => now)
  assert.deepEqual(provider.calls.map(call => new URL(call.url).pathname), ['/v26.0/me/messages','/v26.0/30000001/replies'])
  assert.deepEqual(provider.calls[1].body, { message: 'Enviei na DM!' })
  assert.equal((await store.getEvent(id)).state, 'provider_accepted')
  const record = await store.getPublicReply(id)
  assert.equal(record.reply?.state, 'provider_accepted')
  assert.equal(record.reply?.provider_reply_id, '50000001')
  assert.equal(record.attempts.length, 1)
  await Promise.all([processJob(store, env, { eventId: id }, provider.fetch, () => now), processJob(store, env, { eventId: id, kind: 'public_reply' }, provider.fetch, () => now)])
  await store.recover(now + 120, 30)
  await publishPending(store, env, now + 120)
  assert.equal(provider.calls.length, 2)
  assert.equal(jobs.length, 0)
})
test('unconfigured rules only send the DM and public text is validated', async () => {
  assert.equal(ruleDefinitionSchema.safeParse({ ...definition, publicReplyText: ' ' }).success, false)
  assert.equal(ruleDefinitionSchema.safeParse({ ...definition, publicReplyText: 'x'.repeat(501) }).success, false)
  await rule(false)
  const id = await event()
  const provider = fetcher()
  await processJob(store, env, { eventId: id }, provider.fetch, () => now)
  assert.equal(provider.calls.length, 1)
  assert.equal((await store.getPublicReply(id)).reply, null)
})
test('rejected or uncertain DMs never create or send a public confirmation', async () => {
  await rule()
  for (const [index, response] of [() => Response.json({ error: { code: 100 } }, { status: 400 }), () => { throw new Error('test timeout') }].entries()) {
    const id = await event(String(30000001 + index))
    let calls = 0
    await processJob(store, env, { eventId: id }, async () => { calls++; return response() }, () => now)
    await processJob(store, env, { eventId: id, kind: 'public_reply' }, async () => { calls++; throw new Error('unexpected public send') }, () => now)
    assert.equal(calls, 1)
    assert.equal((await store.getPublicReply(id)).reply, null)
  }
})
test('public replies keep the original text when the rule is edited', async () => {
  const active = await rule()
  const id = await event()
  await store.updateRule(active.id, active.revision, { ...definition, publicReplyText: 'Changed text' }, null, 'test-only', now + 1)
  const provider = fetcher()
  await processJob(store, env, { eventId: id }, provider.fetch, () => now + 2)
  assert.deepEqual(provider.calls[1].body, { message: 'Enviei na DM!' })
})
test('a durable public intent survives interruption after DM acceptance and uses a separate queue job', async () => {
  await rule()
  const id = await event()
  await acceptDm(id)
  await store.recover(now + 60, 30)
  await publishPending(store, env, now + 60)
  assert.deepEqual(jobs, [{ eventId: id, kind: 'public_reply' }])
  const provider = fetcher()
  await processJob(store, env, jobs[0], provider.fetch, () => now + 60)
  assert.equal(provider.calls.length, 1)
  assert.ok(provider.calls[0].url.endsWith('/30000001/replies'))
  assert.equal((await store.getEvent(id)).attempts, 1)
})
test('temporary public rejection retries only the public reply and preserves DM receipt timing', async () => {
  await rule()
  const id = await event()
  let attempts = 0
  const provider = fetcher(() => ++attempts === 1 ? Response.json({ error: { code: 4 } }, { status: 429 }) : Response.json({ id: '50000001' }))
  await processJob(store, env, { eventId: id }, provider.fetch, () => now)
  assert.equal((await store.getPublicReply(id)).reply?.state, 'retry')
  await publishPending(store, env, now + 59)
  assert.equal(jobs.length, 0)
  await publishPending(store, env, now + 60)
  assert.deepEqual(jobs, [{ eventId: id, kind: 'public_reply' }])
  await processJob(store, env, jobs[0], provider.fetch, () => now + 60)
  assert.equal(provider.calls.filter(call => call.url.endsWith('/me/messages')).length, 1)
  assert.equal((await store.getPublicReply(id)).reply?.state, 'provider_accepted')
  assert.equal((await store.getEvent(id)).updated_at, now)
})
test('public timeout and invalid receipts stay uncertain and cannot be retried by queue redelivery', async () => {
  await rule()
  for (const [index, response] of [() => { throw new Error('test timeout') }, () => Response.json({ message_id: 'not-public', recipient_id: 'not-public' }), () => new Response('{}', { status: 302, headers: { Location: 'https://untrusted.example' } })].entries()) {
    const id = await event(String(30000001 + index))
    const provider = fetcher(response)
    await processJob(store, env, { eventId: id }, provider.fetch, () => now)
    assert.equal((await store.getEvent(id)).state, 'provider_accepted')
    assert.equal((await store.getPublicReply(id)).reply?.state, 'send_unknown')
    await store.recover(now + 120, 30)
    await store.deadLetterPublic(id, now + 121)
    await processJob(store, env, { eventId: id, kind: 'public_reply' }, provider.fetch, () => now + 122)
    assert.equal(provider.calls.length, 2)
    assert.ok(provider.calls.every(call => new URL(call.url).hostname === 'graph.instagram.com'))
  }
  const status = await queueStatus(env, store, now + 122)
  assert.equal(status.alerts.filter(alert => alert.code === 'public_reply_uncertain_send_requires_review')[0].count, 3)
})
test('paused, disabled and expired events cannot publish confirmations', async () => {
  const active = await rule()
  const id = await event()
  await acceptDm(id)
  await store.setPaused(true, 1, 'test-only', now + 1)
  assert.equal(await store.claimPublicReply(id, 'paused-claim', now + 2), null)
  await publishPending(store, env, now + 2)
  assert.equal(jobs.length, 0)
  await store.setPaused(false, 2, 'test-only', now + 3)
  assert.equal(await store.claimPublicReply(id, 'expired-claim', now + 7 * 86400), null)
  await store.updateRule(active.id, active.revision, null, false, 'test-only', now + 4)
  assert.equal((await store.getPublicReply(id)).reply?.state, 'canceled')
  assert.equal(await store.claimPublicReply(id, 'disabled-claim', now + 5), null)
})
test('interrupted public sends are retained as uncertain and concurrent claims have one winner', async () => {
  await rule()
  const id = await event()
  await acceptDm(id)
  const claims = await Promise.all([store.claimPublicReply(id, 'claim-one', now + 1),store.claimPublicReply(id, 'claim-two', now + 1)])
  assert.equal(claims.filter(Boolean).length, 1)
  await store.recover(now + 92, 30)
  const record = await store.getPublicReply(id)
  assert.equal(record.reply?.state, 'send_unknown')
  assert.equal((record.attempts[0] as { outcome: string }).outcome, 'send_unknown')
  await publishPending(store, env, now + 93)
  assert.equal(jobs.length, 0)
  assert.equal(await store.claimPublicReply(id, 'claim-three', now + 93), null)
})

test('post cooldown prevents both the second DM and its public confirmation', async () => {
  const active = await rule()
  await store.updateRule(active.id, active.revision, { ...definition, cooldownSeconds: 86400 }, null, 'test-only', now)
  const provider = fetcher()
  const first = await event('30000001')
  await processJob(store, env, { eventId: first }, provider.fetch, () => now)
  const second = await event('30000002')
  await processJob(store, env, { eventId: second }, provider.fetch, () => now + 1)
  assert.equal(provider.calls.length, 2)
  assert.equal((await store.getEvent(second)).reason, 'contact_cooldown')
  assert.equal((await store.getPublicReply(second)).reply, null)
})

test('the same person receives two DMs from two posts while same-post duplicates remain limited', async () => {
  const firstRule = await rule()
  await store.updateRule(firstRule.id, firstRule.revision, { ...definition, cooldownSeconds: 86400 }, null, 'test-only', now)
  const secondDefinition = { ...definition, name: 'Second post', scope: { kind: 'selected' as const, mediaIds: ['20000002'] }, cooldownSeconds: 86400 }
  const secondRule = await store.createRule(secondDefinition, 'test-only', now)
  await store.updateRule(secondRule.id, secondRule.revision, null, true, 'test-only', now)
  const first = await event('30000001', '20000001')
  const second = await event('30000002', '20000002')
  const provider = fetcher()
  await Promise.all([first,second].map(eventId => processJob(store, env, { eventId }, provider.fetch, () => now)))
  assert.equal(provider.calls.filter(call => call.url.endsWith('/me/messages')).length, 2)
  assert.equal(provider.calls.filter(call => call.url.endsWith('/replies')).length, 2)
  assert.equal((await store.getEvent(first)).state, 'provider_accepted')
  assert.equal((await store.getEvent(second)).state, 'provider_accepted')
  const gates = await store.rows<{ media_id: string; next_allowed_at: number }>('SELECT media_id,next_allowed_at FROM @schema.post_contact_gates ORDER BY media_id')
  assert.deepEqual(gates.map(gate => gate.media_id), ['20000001','20000002'])
  assert.ok(gates.every(gate => gate.next_allowed_at === now + 86400))
  const duplicate = await event('30000003', '20000001')
  await processJob(store, env, { eventId: duplicate }, provider.fetch, () => now + 1)
  assert.equal((await store.getEvent(duplicate)).reason, 'contact_cooldown')
  assert.equal(provider.calls.length, 4)
})
test('different rules on the same post share the 24-hour limit and another DM is allowed after it', async () => {
  const firstRule = await rule()
  await store.updateRule(firstRule.id, firstRule.revision, { ...definition, cooldownSeconds: 86400 }, null, 'test-only', now)
  const secondRule = await store.createRule({ ...definition, name: 'Other keyword', keywords: ['OUTRA'], cooldownSeconds: 86400 }, 'test-only', now)
  await store.updateRule(secondRule.id, secondRule.revision, null, true, 'test-only', now)
  const provider = fetcher()
  const first = await event('30000001')
  await processJob(store, env, { eventId: first }, provider.fetch, () => now)
  await store.acceptComments([{ accountId: account, commentId: '30000002', commenterId: '40000001', mediaId: '20000001', text: 'OUTRA', timestamp: now }], now)
  const second = account + ':30000002'
  await processJob(store, env, { eventId: second }, provider.fetch, () => now + 1)
  assert.equal((await store.getEvent(second)).rule_id, secondRule.id)
  assert.equal((await store.getEvent(second)).reason, 'contact_cooldown')
  assert.equal(provider.calls.length, 2)
  const later = await event('30000003')
  await processJob(store, env, { eventId: later }, provider.fetch, () => now + 86400)
  assert.equal((await store.getEvent(later)).state, 'provider_accepted')
  assert.equal(provider.calls.length, 4)
})
test('an uncertain DM reserves only its own post and does not block a different post', async () => {
  const active = await rule()
  await store.updateRule(active.id, active.revision, { ...definition, scope: { kind: 'all' }, cooldownSeconds: 86400 }, null, 'test-only', now)
  const first = await event('30000001', '20000001')
  await processJob(store, env, { eventId: first }, async () => { throw new Error('test timeout') }, () => now)
  assert.equal((await store.getEvent(first)).state, 'send_unknown')
  const provider = fetcher()
  const second = await event('30000002', '20000002')
  await processJob(store, env, { eventId: second }, provider.fetch, () => now + 1)
  assert.equal((await store.getEvent(second)).state, 'provider_accepted')
  const repeat = await event('30000003', '20000001')
  await processJob(store, env, { eventId: repeat }, provider.fetch, () => now + 2)
  assert.equal((await store.getEvent(repeat)).reason, 'contact_cooldown')
  assert.equal(provider.calls.length, 2)
})
test('migration preserves legacy cooldowns on their original post without blocking another post', async () => {
  const active = await rule()
  await store.updateRule(active.id, active.revision, { ...definition, scope: { kind: 'all' }, cooldownSeconds: 86400 }, null, 'test-only', now)
  const original = await event('30000001', '20000001')
  await acceptDm(original)
  await store.rows('INSERT INTO @schema.contact_gates(account_id,commenter_id,owner_event_id,next_allowed_at) VALUES($1,$2,$3,$4)', [account,'40000001',original,now+86400])
  await store.rows('DELETE FROM @schema.post_contact_gates')
  const migration = (await readFile(new URL('../migrations/0004_post_cooldowns.sql', import.meta.url), 'utf8')).replaceAll('instagram_automation',schema)
  await db.transaction(async tx => { await tx.exec(migration) })
  const gates = await store.rows<{ media_id: string; owner_event_id: string; next_allowed_at: number }>('SELECT media_id,owner_event_id,next_allowed_at FROM @schema.post_contact_gates')
  assert.deepEqual(gates,[{media_id:'20000001',owner_event_id:original,next_allowed_at:now+86400}])
  const provider = fetcher()
  const samePost = await event('30000002','20000001')
  await processJob(store, env, { eventId: samePost }, provider.fetch, () => now + 1)
  assert.equal((await store.getEvent(samePost)).reason, 'contact_cooldown')
  const otherPost = await event('30000003','20000002')
  await processJob(store, env, { eventId: otherPost }, provider.fetch, () => now + 2)
  assert.equal((await store.getEvent(otherPost)).state, 'provider_accepted')
  assert.equal(provider.calls.length, 2)
  assert.equal((await store.rows('SELECT * FROM @schema.contact_gates')).length,1)
})
test('a rejected send releases only its post reservation and preserves another post cooldown', async () => {
  const active = await rule()
  await store.updateRule(active.id, active.revision, { ...definition, scope: { kind: 'all' }, cooldownSeconds: 86400 }, null, 'test-only', now)
  const accepted = await event('30000001','20000001')
  await acceptDm(accepted)
  const failed = await event('30000002','20000002')
  const claimed = await store.claim(failed,'rejected-claim',now+1)
  assert.ok(claimed)
  await store.finish(claimed,{state:'failed',reason:'meta_rejected'},now+2)
  const gates = await store.rows<{media_id:string}>('SELECT media_id FROM @schema.post_contact_gates')
  assert.deepEqual(gates,[{media_id:'20000001'}])
  const repeat = await event('30000003','20000001')
  assert.equal(await store.claim(repeat,'repeat-claim',now+3),null)
  const eligible = await event('30000004','20000002')
  assert.ok(await store.claim(eligible,'new-post-claim',now+3))
})
