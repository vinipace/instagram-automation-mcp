import { z } from 'zod'
import {
  type Env,
  type Job,
  idSchema,
  PublicError,
  secondsNow,
} from './domain.mts'
import {
  authenticate,
  equalSecret,
  readBody,
  verifySignature,
} from './security.mts'
import { parseComments } from './webhook.mts'
import { Store } from './store.mts'
import { retentionDays, serveMcp } from './mcp.mts'
import { processJob, publishPending } from './processor.mts'
import { renderPrivacyPage } from './privacy.mts'
import { activeToken, refreshCredential } from './credentials.mts'

const jobSchema = z.object({ eventId: idSchema, kind: z.literal('public_reply').optional() }).strict()
export function createWorker(
  makeStore = (env: Env) => new Store(env.DATABASE_URL, env.IG_ACCOUNT_ID),
  fetcher: typeof fetch = fetch,
) {
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: Pick<ExecutionContext, 'waitUntil'>,
    ): Promise<Response> {
      const url = new URL(request.url)
      try {
        if (url.pathname === '/privacy' && request.method === 'GET') {
          const page = renderPrivacyPage(env, retentionDays(env))
          if (!page) return new Response('Privacy notice is not configured. Set OPERATOR_NAME and an HTTPS OPERATOR_CONTACT_URL.', { status: 503 })
          return new Response(page, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'no-referrer',
            },
          })
        }
        if (url.pathname === '/health' && request.method === 'GET') {
          return Response.json(
            {
              service: 'instagram-automation-mcp',
              status: 'up',
              version: '1.0.0',
            },
            { headers: { 'Cache-Control': 'no-store' } },
          )
        }
        if (url.pathname === '/mcp') {
          const identity = await authenticate(request, env)
          if (!identity)
            return new Response('Unauthorized', {
              status: 401,
              headers: {
                'WWW-Authenticate': 'Bearer',
                'Cache-Control': 'no-store',
              },
            })
          if (!env.DATABASE_URL)
            return new Response('Database is not configured', { status: 503 })
          return await serveMcp(
            request,
            env,
            identity,
            makeStore(env),
            (promise) => ctx.waitUntil(promise),
            fetcher,
          )
        }
        if (url.pathname !== '/webhooks/instagram')
          return new Response('Not found', { status: 404 })
        if (request.method === 'GET') {
          if (!env.META_VERIFY_TOKEN)
            return new Response('Webhook verification is not configured', {
              status: 503,
            })
          const challenge = url.searchParams.get('hub.challenge')
          if (
            url.searchParams.get('hub.mode') === 'subscribe' &&
            challenge &&
            (await equalSecret(
              url.searchParams.get('hub.verify_token') ?? '',
              env.META_VERIFY_TOKEN,
            ))
          ) {
            return new Response(challenge, {
              headers: {
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-store',
              },
            })
          }
          return new Response('Forbidden', { status: 403 })
        }
        if (request.method !== 'POST')
          return new Response('Method not allowed', { status: 405 })
        if (!env.META_APP_SECRET || !env.IG_ACCOUNT_ID || !env.DATABASE_URL)
          return new Response('Webhook setup is incomplete', { status: 503 })
        let body: string
        try {
          body = await readBody(request)
        } catch {
          return new Response('Invalid or oversized body', { status: 413 })
        }
        if (
          !(await verifySignature(
            body,
            request.headers.get('x-hub-signature-256'),
            env.META_APP_SECRET,
          ))
        )
          return new Response('Forbidden', { status: 403 })
        let payload: unknown
        try {
          payload = JSON.parse(body)
        } catch {
          return new Response('Invalid JSON', { status: 400 })
        }
        const now = secondsNow()
        const comments = parseComments(payload, env.IG_ACCOUNT_ID, now)
        const store = makeStore(env)
        const accepted = await store.acceptComments(comments, now)
        // Durable commit precedes acknowledgment. Cron repairs a failed publication.
        ctx.waitUntil(publishPending(store, env, now))
        return Response.json(
          { received: true, ...accepted },
          { headers: { 'Cache-Control': 'no-store' } },
        )
      } catch (error) {
        return new Response(
          error instanceof PublicError
            ? error.message
            : 'Storage or service temporarily unavailable',
          { status: error instanceof PublicError ? 400 : 503 },
        )
      }
    },
    async queue(batch: MessageBatch<Job>, env: Env) {
      const store = makeStore(env)
      // Credential failures happen before any send claim. Queue retries remain safe.
      const sendingEnv = env.META_TOKEN_ENCRYPTION_KEY && batch.queue !== env.DLQ_NAME
        ? { ...env, META_ACCESS_TOKEN: await activeToken(env, store) } : env
      for (const message of batch.messages) {
        const job = jobSchema.safeParse(message.body)
        if (!job.success) {
          message.ack()
          continue
        }
        try {
          if (batch.queue === env.DLQ_NAME) {
            if (job.data.kind === 'public_reply') await store.deadLetterPublic(job.data.eventId, secondsNow())
            else await store.deadLetter(job.data.eventId, secondsNow())
          }
          else await processJob(store, sendingEnv, job.data, fetcher)
          message.ack()
        } catch {
          message.retry({
            delaySeconds: Math.min(
              60 * 2 ** Math.min(message.attempts, 6),
              3600,
            ),
          })
        }
      }
    },
    async scheduled(_controller: ScheduledController, env: Env) {
      const store = makeStore(env)
      const now = secondsNow()
      await store.recover(now, retentionDays(env))
      await publishPending(store, env, now)
      if (env.META_TOKEN_ENCRYPTION_KEY) {
        try { await refreshCredential(env, store, 'automatic_renewal', now, true, fetcher) }
        catch { /* Durable refresh errors are exposed through health/token alerts. */ }
      }
    },
  }
}
export default createWorker()
