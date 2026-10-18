import assert from 'node:assert/strict'
import test from 'node:test'
import {
  matchRule,
  preview,
  replyDeadline,
  ruleDefinitionSchema,
  type Rule,
  type Env,
  type EventRecord,
} from '../src/domain.mts'
import { authenticate, readBody, verifySignature } from '../src/security.mts'
import { parseComments } from '../src/webhook.mts'
import { classifyResponse, sendReply } from '../src/meta.mts'

const now = 1791240000
function rule(overrides = {}): Rule {
  return {
    id: 'a',
    account_id: 'ig',
    revision: 1,
    enabled: true,
    actor: 'test',
    created_at: now,
    updated_at: now,
    definition: ruleDefinitionSchema.parse({
      name: 'Curso',
      keywords: ['CURSO'],
      scope: { kind: 'selected', mediaIds: ['reel'] },
      replyText: 'Link aprovado',
      ...overrides,
    }),
  }
}
test('whole-word matching handles casing, punctuation and Unicode without matching substrings', () => {
  assert.equal(matchRule(rule(), 'Quero o CuRsO! 😀', 'reel', now), 'matched')
  for (const text of [
    'concursos',
    'cursos',
    'meu_curso',
    'précurso',
    'cursoção',
  ])
    assert.equal(matchRule(rule(), text, 'reel', now), 'keyword_not_matched')
  assert.equal(
    matchRule(rule({ keywords: ['C++'] }), 'Quero C++!', 'reel', now),
    'matched',
  )
  assert.equal(
    matchRule(rule({ keywords: ['ação'] }), 'AÇÃO!', 'reel', now),
    'matched',
  )
})
test('exact, accent normalization, media scope and scheduled boundaries are explicit', () => {
  assert.equal(
    matchRule(rule({ matchMode: 'exact' }), '  CURSO  ', 'reel', now),
    'matched',
  )
  assert.equal(
    matchRule(rule({ matchMode: 'exact' }), 'quero curso', 'reel', now),
    'keyword_not_matched',
  )
  assert.equal(
    matchRule(rule({ keywords: ['ação'] }), 'acao', 'reel', now),
    'keyword_not_matched',
  )
  assert.equal(
    matchRule(
      rule({ keywords: ['ação'], ignoreAccents: true }),
      'acao',
      'reel',
      now,
    ),
    'matched',
  )
  assert.equal(matchRule(rule(), 'curso', 'other', now), 'media_out_of_scope')
  assert.equal(
    matchRule(rule({ startsAt: now + 1 }), 'curso', 'reel', now),
    'not_started',
  )
  assert.equal(matchRule(rule({ endsAt: now }), 'curso', 'reel', now), 'ended')
})
test('trailing-letter repetition is opt-in and accepts excited comments without changing other letters', () => {
  const strict = rule({ keywords: ['QUERO'] })
  assert.equal(strict.definition.allowTrailingLetterRepeat, false)
  assert.equal(matchRule(strict, 'Queroooo', 'reel', now), 'keyword_not_matched')
  const excited = rule({ keywords: ['QUERO'], allowTrailingLetterRepeat: true })
  for (const text of ['QUERO','Queroooo','Queroooooo','qUeRoOOO!','Eu querooo 😍','"queroooo"','quer' + 'o'.repeat(500)])
    assert.equal(matchRule(excited,text,'reel',now),'matched',text)
  for (const text of ['querooos','querozinha','queroooo1','queroooo_','requerooo','quuerrooo','querrooo','qeroooo'])
    assert.equal(matchRule(excited,text,'reel',now),'keyword_not_matched',text)
})
test('trailing-letter matching keeps exact mode and phrase boundaries explicit', () => {
  const exact = rule({ keywords: ['QUERO'], matchMode: 'exact', allowTrailingLetterRepeat: true })
  assert.equal(matchRule(exact,'  QuErOooo  ','reel',now),'matched')
  for (const text of ['Eu querooo','querooo!','querooo mesmo'])
    assert.equal(matchRule(exact,text,'reel',now),'keyword_not_matched')
  const phrase = rule({ keywords: ['QUERO CURSO'], allowTrailingLetterRepeat: true })
  assert.equal(matchRule(phrase,'Quero cursoooo!','reel',now),'matched')
  assert.equal(matchRule(phrase,'Querooo curso','reel',now),'keyword_not_matched')
})
test('trailing-letter matching preserves Unicode, accent choices and doubled letters in keywords', () => {
  assert.equal(matchRule(rule({keywords:['AÇÃO'],allowTrailingLetterRepeat:true}),'açãoooo!','reel',now),'matched')
  assert.equal(matchRule(rule({keywords:['CAFÉ'],allowTrailingLetterRepeat:true}),'cafééé','reel',now),'matched')
  assert.equal(matchRule(rule({keywords:['CAFÉ'],allowTrailingLetterRepeat:true}),'cafeee','reel',now),'keyword_not_matched')
  assert.equal(matchRule(rule({keywords:['CAFÉ'],allowTrailingLetterRepeat:true,ignoreAccents:true}),'cafeee','reel',now),'matched')
  const doubled = rule({keywords:['coffee'],allowTrailingLetterRepeat:true})
  assert.equal(matchRule(doubled,'coffeeee','reel',now),'matched')
  assert.equal(matchRule(doubled,'cofeee','reel',now),'keyword_not_matched')
})
test('trailing-letter matching never extends terminal numbers or punctuation and still honors rule scope', () => {
  for (const [keyword,text] of [['1000','10000'],['C++','C+++']]) {
    const r = rule({keywords:[keyword],matchMode:'exact',allowTrailingLetterRepeat:true})
    assert.equal(matchRule(r,keyword,'reel',now),'matched')
    assert.equal(matchRule(r,text,'reel',now),'keyword_not_matched')
  }
  const excited = rule({keywords:['QUERO'],allowTrailingLetterRepeat:true})
  assert.equal(matchRule(excited,'querooo','other',now),'media_out_of_scope')
  assert.equal(matchRule({...excited,enabled:false},'querooo','reel',now),'disabled')
  assert.equal(ruleDefinitionSchema.safeParse({...excited.definition,allowTrailingLetterRepeat:'yes'}).success,false)
})
test('one winner uses priority and a stable ID tie-break; disabled rules never win', () => {
  const a = rule()
  const b = { ...rule({ priority: 4 }), id: 'b' }
  assert.equal(preview([a, b], 'curso', 'reel', now).winner?.id, 'b')
  assert.equal(preview([b, a], 'curso', 'reel', now).winner?.id, 'b')
  assert.equal(
    preview([{ ...b, enabled: false }, a], 'curso', 'reel', now).winner?.id,
    'a',
  )
  assert.equal(
    preview([b, { ...b, id: 'a' }], 'curso', 'reel', now).winner?.id,
    'a',
  )
})
test('invalid rules are rejected before being saved', () => {
  assert.throws(() => rule({ keywords: ['   '] }))
  assert.throws(() => rule({ keywords: ['.*'] }))
  assert.throws(() => rule({ scope: { kind: 'selected', mediaIds: [] } }))
  assert.throws(() => rule({ startsAt: now, endsAt: now }))
  assert.throws(() => rule({ replyText: 'x'.repeat(1001) }))
  assert.throws(() => rule({ enabled: true }))
})
test('raw-body HMAC rejects tampering, malformed signatures and missing configuration', async () => {
  const body = '{"entry":[]}'
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('app-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature =
    'sha256=' +
    Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
    ).toString('hex')
  assert.equal(await verifySignature(body, signature, 'app-secret'), true)
  assert.equal(
    await verifySignature(`${body} `, signature, 'app-secret'),
    false,
  )
  assert.equal(await verifySignature(body, signature, undefined), false)
  assert.equal(await verifySignature(body, 'sha256=bad', 'app-secret'), false)
})
test('MCP requires strong bearer tokens and rejects a foreign browser Origin', async () => {
  const token = 'x'.repeat(40)
  const env = { MCP_READ_TOKEN: token } as Env
  const identity = await authenticate(
    new Request('https://worker.test/mcp', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  )
  assert.ok(identity)
  assert.deepEqual([...identity.permissions], ['read'])
  assert.equal(
    await authenticate(
      new Request('https://worker.test/mcp', {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: 'https://evil.test',
        },
      }),
      env,
    ),
    null,
  )
  assert.equal(
    await authenticate(new Request('https://worker.test/mcp'), env),
    null,
  )
  assert.equal(
    await authenticate(
      new Request('https://worker.test/mcp', {
        headers: { Authorization: 'Bearer short' },
      }),
      { MCP_ADMIN_TOKEN: 'short' } as Env,
    ),
    null,
  )
})
test('body size cap also applies when content-length is absent', async () => {
  await assert.rejects(
    readBody(
      new Request('https://worker.test', {
        method: 'POST',
        body: 'a'.repeat(100),
      }),
      50,
    ),
  )
})
test('comment parsing uses provider event time and filters foreign accounts, Live and unrelated fields', () => {
  const value = {
    id: 'c1',
    text: 'curso',
    from: { id: 'u1' },
    media: { id: 'reel' },
  }
  const payload = {
    object: 'instagram',
    entry: [
      {
        id: 'ig',
        time: now,
        changes: [
          { field: 'comments', value },
          { field: 'messages', value },
        ],
      },
    ],
  }
  assert.equal(parseComments(payload, 'ig', now)[0].timestamp, now)
  assert.equal(parseComments(payload, 'other', now).length, 0)
  assert.throws(() =>
    parseComments(
      { ...payload, entry: [{ ...payload.entry[0], time: undefined }] },
      'ig',
      now,
    ),
  )
  assert.throws(() =>
    parseComments(
      { ...payload, entry: [{ ...payload.entry[0], time: now + 400 }] },
      'ig',
      now,
    ),
  )
  assert.equal(
    parseComments(
      {
        ...payload,
        entry: [
          {
            ...payload.entry[0],
            changes: [
              {
                field: 'comments',
                value: {
                  ...value,
                  media: { id: 'reel', media_product_type: 'LIVE' },
                },
              },
            ],
          },
        ],
      },
      'ig',
      now,
    ).length,
    0,
  )
  assert.equal(replyDeadline(now), now + 7 * 86400 - 60)
})
test('documented Instagram Login direct entries and batched envelopes use the same comment context', () => {
  const entry = {
    id: 'ig',
    time: now,
    field: 'comments',
    value: {
      id: 'c1',
      text: 'curso',
      from: { id: 'u1', username: 'tester' },
      media: { id: 'reel', media_product_type: 'REELS' },
    },
  }
  const envelope = { object: 'instagram', entry: [entry] }
  assert.deepEqual(parseComments([envelope], 'ig', now), [
    {
      accountId: 'ig',
      commentId: 'c1',
      commenterId: 'u1',
      mediaId: 'reel',
      text: 'curso',
      timestamp: now,
    },
  ])
  assert.equal(parseComments(envelope, 'other', now).length, 0)
  assert.equal(
    parseComments(
      { ...envelope, entry: [{ ...entry, field: 'live_comments' }] },
      'ig',
      now,
    ).length,
    0,
  )
  for (const invalid of [
    { ...entry, time: undefined },
    { ...entry, time: now + 400 },
    { ...entry, changes: [{ field: 'comments', value: entry.value }] },
    { ...entry, value: { ...entry.value, from: {} } },
  ]) {
    assert.throws(() =>
      parseComments({ ...envelope, entry: [invalid] }, 'ig', now),
    )
  }
  assert.throws(() => parseComments([], 'ig', now))
})
test('provider batches accept 1000 notifications and reject excess across envelopes', () => {
  const changes = Array.from({ length: 1000 }, (_, index) => ({
    field: 'comments',
    value: {
      id: `c${index}`,
      text: 'curso',
      from: { id: 'u1' },
      media: { id: 'reel' },
    },
  }))
  const envelope = {
    object: 'instagram',
    entry: [{ id: 'ig', time: now, changes }],
  }
  assert.equal(parseComments(envelope, 'ig', now).length, 1000)
  assert.throws(() => parseComments([envelope, envelope], 'ig', now))
})
const event = {
  comment_id: 'c1',
  reply_text: 'Link aprovado',
  attempts: 1,
  max_attempts: 5,
  expires_at: now + 10000,
} as EventRecord
test('provider receipts, explicit rejection, retry and uncertain responses remain distinct', () => {
  assert.equal(
    classifyResponse(
      200,
      { message_id: 'm1', recipient_id: 'u1' },
      event,
      now,
      null,
    ).state,
    'provider_accepted',
  )
  assert.equal(
    classifyResponse(200, {}, event, now, null).state,
    'send_unknown',
  )
  assert.equal(
    classifyResponse(
      503,
      { error: { code: 2, is_transient: true } },
      event,
      now,
      null,
    ).state,
    'send_unknown',
  )
  const retry = classifyResponse(429, { error: { code: 4 } }, event, now, '120')
  assert.equal(retry.state, 'retry')
  assert.equal(retry.nextAttemptAt, now + 120)
  assert.equal(
    classifyResponse(400, { error: { code: 190 } }, event, now, null).state,
    'blocked',
  )
  assert.equal(
    classifyResponse(400, { error: { code: 100 } }, event, now, null)
      .safeToRetry,
    undefined,
  )
  assert.equal(
    classifyResponse(
      429,
      { error: { code: 4 } },
      { ...event, attempts: 5 },
      now,
      null,
    ).state,
    'failed',
  )
})
test('private reply uses the comment context and records a network failure as uncertain', async () => {
  let sent: unknown
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, 'https://graph.instagram.com/v99.0/me/messages')
    sent = JSON.parse(String(init?.body))
    throw new Error('connection lost')
  }) as typeof fetch
  const outcome = await sendReply(
    {
      IG_ACCOUNT_ID: 'ig',
      META_API_VERSION: 'v99.0',
      META_ACCESS_TOKEN: 'test-only',
    } as Env,
    event,
    now,
    fetcher,
  )
  assert.deepEqual(sent, {
    recipient: { comment_id: 'c1' },
    message: { text: 'Link aprovado' },
  })
  assert.equal(outcome.state, 'send_unknown')
})
