import { z } from 'zod'
import type { Env, EventRecord, PublicReplyRecord } from './domain.mts'
import type { Outcome } from './store.mts'
const receipt = z.object({
  message_id: z.string().min(1),
  recipient_id: z.string().min(1),
})
const graphError = z.object({
  error: z.object({
    code: z.number().int(),
    error_subcode: z.number().int().optional(),
    is_transient: z.boolean().optional(),
  }),
})
export function classifyResponse(
  status: number,
  body: unknown,
  event: Pick<EventRecord, 'attempts' | 'max_attempts' | 'expires_at'>,
  now: number,
  retryAfter: string | null,
): Outcome {
  const accepted = receipt.safeParse(body)
  if (status >= 200 && status < 300 && accepted.success) {
    return {
      state: 'provider_accepted',
      reason: 'meta_accepted',
      messageId: accepted.data.message_id,
      recipientId: accepted.data.recipient_id,
    }
  }
  const parsed = graphError.safeParse(body)
  // Server errors and missing receipts do not prove the send was rejected.
  if (status >= 500 || status < 400 || !parsed.success)
    return { state: 'send_unknown', reason: 'ambiguous_provider_response' }
  const error = parsed.data.error
  const codes = { errorCode: error.code, errorSubcode: error.error_subcode }
  if ([190, 10, 200].includes(error.code) || status === 401 || status === 403) {
    return {
      state: 'blocked',
      reason: 'meta_permission_or_token_error',
      safeToRetry: true,
      ...codes,
    }
  }
  const temporary =
    status === 429 ||
    [4, 17, 32, 613].includes(error.code) ||
    error.is_transient === true
  if (!temporary) return { state: 'failed', reason: 'meta_rejected', ...codes }
  const headerDelay =
    retryAfter === null
      ? 0
      : /^\d+$/.test(retryAfter)
        ? Number(retryAfter)
        : Date.parse(retryAfter) / 1000 - now
  const delay = Math.max(
    60 * 2 ** Math.min(event.attempts - 1, 6),
    Number.isFinite(headerDelay) ? Math.max(headerDelay, 0) : 0,
  )
  if (event.attempts >= event.max_attempts || now + delay >= event.expires_at) {
    return {
      state: 'failed',
      reason: 'send_retries_exhausted',
      safeToRetry: true,
      ...codes,
    }
  }
  return {
    state: 'retry',
    reason: 'meta_temporary_rejection',
    safeToRetry: true,
    nextAttemptAt: now + delay,
    ...codes,
  }
}
export async function sendReply(
  env: Env,
  event: EventRecord,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<Outcome> {
  try {
    const response = await fetcher(
      // Meta supports /me/messages for Instagram Login. It resolves the sender
      // from the token, whose app-scoped ID differs from the webhook account ID.
      `https://graph.instagram.com/${env.META_API_VERSION}/me/messages`,
      {
        method: 'POST',
        // Workers rejects redirect: 'error' before making the request. Manual
        // mode supports this runtime and never forwards the bearer to a redirect.
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { comment_id: event.comment_id },
          message: { text: event.reply_text },
        }),
        signal: AbortSignal.timeout(10000),
      },
    )
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return classifyResponse(
      response.status,
      body,
      event,
      now,
      response.headers.get('retry-after'),
    )
  } catch {
    return {
      state: 'send_unknown',
      reason: 'network_or_timeout_after_send_started',
    }
  }
}
export async function sendPublicReply(
  env: Env,
  reply: PublicReplyRecord,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<Outcome> {
  try {
    const response = await fetcher(
      'https://graph.instagram.com/' + env.META_API_VERSION + '/' + encodeURIComponent(reply.comment_id) + '/replies',
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: 'Bearer ' + env.META_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: reply.reply_text }),
        signal: AbortSignal.timeout(10000),
      },
    )
    let body: unknown = null
    try { body = await response.json() } catch { /* Missing receipt is uncertain. */ }
    const parsed = z.object({ id: z.string().regex(/^\d{1,40}$/) }).safeParse(body)
    if (response.status >= 200 && response.status < 300 && parsed.success)
      return { state: 'provider_accepted', reason: 'meta_public_reply_accepted', messageId: parsed.data.id }
    if (response.status < 400)
      return { state: 'send_unknown', reason: 'ambiguous_public_reply_response' }
    return classifyResponse(response.status, body, reply, now, response.headers.get('retry-after'))
  } catch {
    return { state: 'send_unknown', reason: 'network_or_timeout_after_public_reply_started' }
  }
}
