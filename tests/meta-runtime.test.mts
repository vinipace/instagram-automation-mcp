import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import {
  Miniflare,
  Response as MockResponse,
  convertV4MiniflareOptions,
} from 'miniflare'

test('private reply runs in Cloudflare and never follows a credential-bearing redirect', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      contents: `
        import { sendReply, sendPublicReply } from './src/meta.mts';
        export default {
          async fetch(request) {
            const redirect = new URL(request.url).searchParams.has('redirect');
            const publicReply = new URL(request.url).searchParams.has('public');
            const outcome = await (publicReply ? sendPublicReply : sendReply)({
              IG_ACCOUNT_ID: 'webhook-account-test',
              META_API_VERSION: 'v26.0',
              META_ACCESS_TOKEN: 'test-only',
            }, {
              comment_id: redirect ? 'comment-redirect-test' : 'comment-test', reply_text: 'TEST',
              attempts: 1, max_attempts: 5, expires_at: 1700604800,
            }, 1700000000);
            return Response.json(outcome);
          }
        };
      `,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
  })
  const requests: { url: string; method: string; auth: string | null; body: unknown }[] = []
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2026-10-06',
      compatibilityFlags: ['nodejs_compat'],
      script: bundle.outputFiles[0].text,
      outboundService: async (request) => {
        const body = await request.json() as { recipient?: { comment_id: string }; message?: unknown }
        requests.push({
          url: request.url,
          method: request.method,
          auth: request.headers.get('Authorization'),
          body,
        })
        if (body.recipient?.comment_id === 'comment-redirect-test' || request.url.includes('/comment-redirect-test/replies'))
          return new MockResponse('{}', {
            status: 302,
            headers: { Location: 'https://untrusted.example/messages' },
          })
        if (request.url.endsWith('/replies')) return MockResponse.json({ id: '50000001' })
        return MockResponse.json({
          message_id: 'message-test',
          recipient_id: 'recipient-test',
        })
      },
    }),
  )
  try {
    const accepted = await runtime.dispatchFetch('http://test.local')
    assert.deepEqual(await accepted.json(), {
      state: 'provider_accepted',
      reason: 'meta_accepted',
      messageId: 'message-test',
      recipientId: 'recipient-test',
    }, `Outbound calls: ${requests.length}`)
    assert.deepEqual(requests, [{
      url: 'https://graph.instagram.com/v26.0/me/messages',
      method: 'POST',
      auth: 'Bearer test-only',
      body: { recipient: { comment_id: 'comment-test' }, message: { text: 'TEST' } },
    }])
    const redirect = await runtime.dispatchFetch('http://test.local?redirect=1')
    assert.equal((await redirect.json() as { state: string }).state, 'send_unknown')
    assert.equal(requests.length, 2)
    const publicAccepted = await runtime.dispatchFetch('http://test.local?public=1')
    assert.deepEqual(await publicAccepted.json(), { state: 'provider_accepted', reason: 'meta_public_reply_accepted', messageId: '50000001' })
    assert.deepEqual(requests[2], { url: 'https://graph.instagram.com/v26.0/comment-test/replies', method: 'POST', auth: 'Bearer test-only', body: { message: 'TEST' } })
    const publicRedirect = await runtime.dispatchFetch('http://test.local?public=1&redirect=1')
    assert.equal((await publicRedirect.json() as { state: string }).state, 'send_unknown')
    assert.equal(requests.length, 4)
    assert.ok(requests.every(request => new URL(request.url).hostname === 'graph.instagram.com'))
  } finally {
    await runtime.dispose()
  }
})
