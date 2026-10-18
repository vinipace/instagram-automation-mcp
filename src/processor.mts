import { type Env, type Job, sendConfigured, secondsNow } from './domain.mts'
import type { Store } from './store.mts'
import { sendReply, sendPublicReply } from './meta.mts'
export async function publishPending(store: Store, env: Env, now: number) {
  if (env.LIVE_SENDS !== 'true' || !sendConfigured(env)) return
  const ready = await store.reservePublication(now)
  for (const event of ready) {
    try {
      await env.REPLIES.send({ eventId: event.id })
      await store.publicationSucceeded(event.id, now)
    } catch {
      await store.publicationFailed(event.id, now)
    }
  }
  const publicReady = await store.reservePublicPublication(now)
  for (const reply of publicReady) {
    try {
      await env.REPLIES.send({ eventId: reply.event_id, kind: 'public_reply' })
      await store.publicPublicationSucceeded(reply.event_id, now)
    } catch {
      await store.publicPublicationFailed(reply.event_id, now)
    }
  }
}
export async function processPublicJob(
  store: Store,
  env: Env,
  eventId: string,
  fetcher: typeof fetch = fetch,
  clock = secondsNow,
) {
  if (env.LIVE_SENDS !== 'true' || !sendConfigured(env)) return
  const reply = await store.claimPublicReply(eventId, crypto.randomUUID(), clock())
  if (!reply) return
  const eligibility = await store.publicSendEligibility(reply, clock())
  if (eligibility !== 'ready') {
    if (eligibility === 'not_claimed') return
    await store.finishPublicReply(reply, eligibility === 'paused'
      ? { state: 'retry', reason: 'account_paused_before_public_reply', nextAttemptAt: clock() + 60 }
      : { state: 'canceled', reason: eligibility + '_before_public_reply' }, clock())
    return
  }
  await store.finishPublicReply(reply, await sendPublicReply(env, reply, clock(), fetcher), clock())
}
export async function processJob(
  store: Store,
  env: Env,
  job: Job,
  fetcher: typeof fetch = fetch,
  clock = secondsNow,
) {
  if (env.LIVE_SENDS !== 'true' || !sendConfigured(env)) return
  if (job.kind === 'public_reply') {
    await processPublicJob(store, env, job.eventId, fetcher, clock)
    return
  }
  const event = await store.claim(job.eventId, crypto.randomUUID(), clock())
  if (!event) return
  const eligibility = await store.sendEligibility(event, clock())
  if (eligibility !== 'ready') {
    if (eligibility === 'not_claimed') return
    await store.finish(
      event,
      eligibility === 'paused'
        ? {
            state: 'retry',
            reason: 'account_paused_before_send',
            safeToRetry: true,
            nextAttemptAt: clock(),
          }
        : {
            state: 'canceled',
            reason: `${eligibility}_before_send`,
            safeToRetry: false,
          },
      clock(),
    )
    return
  }
  const outcome = await sendReply(env, event, clock(), fetcher)
  await store.finish(event, outcome, clock())
  if (outcome.state === 'provider_accepted' && event.public_reply_text)
    await processPublicJob(store, env, event.id, fetcher, clock)
}
