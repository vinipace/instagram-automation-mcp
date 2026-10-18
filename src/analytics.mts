import { z } from 'zod'
import { type Env, PublicError } from './domain.mts'
import { providerGet, ProviderError, verifyAccount } from './provider.mts'

export const accountMetrics = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'replies', 'profile_links_taps', 'follows_and_unfollows'] as const
export const mediaMetrics = ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'] as const
export function analyticsWindow(since: number | undefined, until: number | undefined, now: number) {
  const end = until ?? now
  const start = since ?? end - 86400
  if (start < 0 || start >= end || end > now || end - start > 31 * 86400)
    throw new PublicError('Use a past positive window no larger than 31 days')
  return { since: start, until: end, timezone: 'UTC' }
}
const metricSchema = z.object({
  name: z.string(), period: z.string(),
  values: z.array(z.object({ value: z.number().finite(), end_time: z.string().optional() })).max(100).optional(),
  total_value: z.object({ value: z.number().finite().optional() }).optional(),
})
export function normalizeMetric(body: unknown, name: string) {
  const parsed = z.object({ data: z.array(metricSchema).max(100) }).safeParse(body)
  if (!parsed.success) throw new ProviderError('invalid_response')
  const metric = parsed.data.data.find(item => item.name === name)
  const values = metric?.values ?? []
  const total = metric?.total_value?.value
  const available = total !== undefined || values.length > 0
  return {
    name, availability: available ? 'available' : 'unavailable', period: metric?.period ?? null,
    total: total ?? null,
    values: values.map(v => ({ value: v.value, endTime: v.end_time ?? null })),
    reason: available ? null : 'provider_returned_no_data',
  }
}
async function metrics(env: Env, token: string, path: string, names: string[], params: Record<string, string>, fetcher: typeof fetch) {
  return Promise.all([...new Set(names)].map(async name => {
    try { return normalizeMetric(await providerGet(env, token, path, { ...params, metric: name }, fetcher), name) }
    catch (error) {
      if (!(error instanceof ProviderError)) throw error
      return { name, availability: 'unavailable', total: null, values: [], reason: error.category, providerErrorCode: error.code ?? null, providerErrorSubcode: error.subcode ?? null }
    }
  }))
}
export async function accountInsights(env: Env, token: string, names: string[], window: { since: number; until: number }, fetcher: typeof fetch = fetch) {
  await verifyAccount(env, token, fetcher)
  const data = await metrics(env, token, `${env.IG_ACCOUNT_ID}/insights`, names, {
    period: 'day', metric_type: 'total_value', since: String(window.since), until: String(window.until),
  }, fetcher)
  return { accountId: env.IG_ACCOUNT_ID, ...window, timezone: 'UTC', metricType: 'total_value', rangeBoundary: 'provider_inclusive', metrics: data, source: 'instagram_api', dataMayLagHours: 48, missingIsZero: false }
}
export async function mediaInsights(env: Env, token: string, mediaId: string, names: string[], fetcher: typeof fetch = fetch) {
  const account = await verifyAccount(env, token, fetcher)
  const parsed = z.object({ id: z.string(), owner: z.object({ id: z.string() }), media_type: z.string(), media_product_type: z.string().optional() }).safeParse(
    await providerGet(env, token, mediaId, { fields: 'id,owner,media_type,media_product_type' }, fetcher),
  )
  if (!parsed.success) throw new ProviderError('invalid_response')
  if (parsed.data.id !== mediaId || ![account.id, account.user_id].includes(parsed.data.owner.id))
    throw new PublicError('Media must belong to the configured Instagram account')
  const data = await metrics(env, token, `${mediaId}/insights`, names, {}, fetcher)
  return { accountId: env.IG_ACCOUNT_ID, mediaId, mediaType: parsed.data.media_type, mediaProductType: parsed.data.media_product_type ?? null, metrics: data, source: 'instagram_api', missingIsZero: false }
}
