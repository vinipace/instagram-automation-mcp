import { z } from 'zod'
import { type Env, PublicError } from './domain.mts'
import { activeToken, credentialRecord, tokenMetadata } from './credentials.mts'
import { providerGet, ProviderError, verifyAccount } from './provider.mts'
import type { Store } from './store.mts'

export async function checkConnection(env: Env, store: Store, now: number, fetcher: typeof fetch = fetch) {
  try {
    const token = await activeToken(env, store)
    const account = await verifyAccount(env, token, fetcher)
    let subscription: { status: string; fields: string[] } = { status: 'unknown', fields: [] }
    try {
      const parsed = z.object({ data: z.array(z.object({ subscribed_fields: z.array(z.string()).optional() })).max(100) }).safeParse(
        await providerGet(env, token, `${env.IG_ACCOUNT_ID}/subscribed_apps`, {}, fetcher),
      )
      if (parsed.success) subscription = { status: 'observed', fields: [...new Set(parsed.data.data.flatMap(app => app.subscribed_fields ?? []))] }
    } catch { /* Account verification remains separate from subscription verification. */ }
    return { checkedAt: now, connection: 'verified', account, subscription, commentsSubscriptionObserved: subscription.fields.includes('comments'), sendingTestPerformed: false, allPermissionsVerified: false }
  } catch (error) {
    return { checkedAt: now, connection: 'failed', account: null, reason: error instanceof ProviderError ? error.category : error instanceof PublicError ? error.message : 'credential_or_storage_unavailable', providerErrorCode: error instanceof ProviderError ? error.code ?? null : null, sendingTestPerformed: false }
  }
}
export async function getTokenStatus(env: Env, store: Store, now: number, fetcher: typeof fetch = fetch) {
  const record = env.META_TOKEN_ENCRYPTION_KEY ? await credentialRecord(store) : null
  const check = await checkConnection(env, store, now, fetcher)
  return { ...tokenMetadata(record, now), validForAccountRead: check.connection === 'verified', checkedAt: now, accountId: env.IG_ACCOUNT_ID, connection: check.connection, expiryUnknownReason: record?.expires_at ? null : 'Exact expiry becomes verified after a successful refresh; no expiry is guessed from an opaque token.' }
}
interface QueueRow { state: string; count: number; oldest_age_seconds: number; oldest_received_at: number; oldest_actionable_age_seconds?: number }
export function reliabilityAlerts(account: { paused: boolean; last_recovery_at: number | null }, backlog: QueueRow[], token: ReturnType<typeof tokenMetadata>, now: number) {
  const alerts: { code: string; severity: string; count?: number }[] = []
  if (account.last_recovery_at === null || now - account.last_recovery_at > 180) alerts.push({ code: 'recovery_heartbeat_stale', severity: 'warning' })
  if (token.secondsUntilExpiry !== null && token.secondsUntilExpiry <= 7 * 86400) alerts.push({ code: token.secondsUntilExpiry <= 0 ? 'token_expired' : 'token_expiring', severity: 'critical' })
  if (token.lastRefreshError) alerts.push({ code: 'token_refresh_failed', severity: 'warning' })
  for (const row of backlog) {
    const actionableAge = row.oldest_actionable_age_seconds ?? row.oldest_age_seconds
    if (row.state === 'send_unknown') alerts.push({ code: 'uncertain_send_requires_review', severity: 'warning', count: row.count })
    if (!account.paused && ['pending', 'retry'].includes(row.state) && actionableAge > 300) alerts.push({ code: 'waiting_work_older_than_five_minutes', severity: 'warning', count: row.count })
    if (row.state === 'sending' && actionableAge > 300) alerts.push({ code: 'send_in_progress_requires_review', severity: 'warning', count: row.count })
  }
  return alerts
}
export async function queueStatus(env: Env, store: Store, now: number) {
  const [account, backlog, record, counts, publicBacklog] = await Promise.all([
    store.settings(), store.backlog(now) as Promise<QueueRow[]>,
    env.META_TOKEN_ENCRYPTION_KEY ? credentialRecord(store) : Promise.resolve(null),
    store.rows<{ eligible: number; queue_publish_failures: number; dead_lettered: number }>(
      `SELECT count(*) FILTER(WHERE state IN ('pending','retry') AND next_attempt_at <= $2 AND expires_at > $2
        AND attempts < max_attempts AND EXISTS(SELECT 1 FROM @schema.rules r WHERE r.id=e.rule_id AND r.enabled))::int AS eligible,
       count(*) FILTER(WHERE reason='queue_publish_failed')::int AS queue_publish_failures,
       count(*) FILTER(WHERE reason='queue_retries_exhausted')::int AS dead_lettered
       FROM @schema.events e WHERE account_id=$1`, [store.accountId, now]),
    store.publicBacklog(now),
  ])
  const token = tokenMetadata(record, now)
  return { asOf: now, accountId: store.accountId, paused: account.paused, liveSends: env.LIVE_SENDS === 'true', backlog,
    ...counts[0], producerConfigured: Boolean(env.REPLIES), failedJobQueue: env.DLQ_NAME ?? null,
    transportQueueDepth: null, coverage: 'durable_send_intents_only', countsIncludeRetainedHistory: true,
    publicReplies: { backlog: publicBacklog, countsIncludeRetainedHistory: true },
    lastRecoveryAt: account.last_recovery_at, token, alerts: [
      ...reliabilityAlerts(account, backlog, token, now),
      ...reliabilityAlerts(account, publicBacklog, token, now)
        .filter(alert => ['uncertain_send_requires_review','waiting_work_older_than_five_minutes','send_in_progress_requires_review'].includes(alert.code))
        .map(alert => ({ ...alert, code: 'public_reply_' + alert.code })),
    ],
    externalNotificationsConfigured: false,
  }
}
