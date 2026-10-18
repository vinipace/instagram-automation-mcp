import { z } from 'zod'
import { type Env, PublicError } from './domain.mts'
import { providerRequest, ProviderError, verifyAccount } from './provider.mts'
import type { Store } from './store.mts'

export interface Credential {
  account_id: string; ciphertext: string; revision: number; stored_at: number
  expires_at: number | null; refresh_not_before: number; next_refresh_at: number
  refreshed_at: number | null; refresh_claim: string | null; refresh_lease_until: number
  last_refresh_error: string | null; last_refresh_error_at: number | null
}
const encoder = new TextEncoder()
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const bytes = (encoded: string) => Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
async function encryptionKey(secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new PublicError('Token encryption key is not configured correctly')
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g)!, v => parseInt(v, 16)), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function encryptToken(token: string, secret: string, accountId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(accountId) }, await encryptionKey(secret), encoder.encode(token))
  return `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`
}
export async function decryptToken(ciphertext: string, secret: string, accountId: string) {
  try {
    const [version, iv, encrypted, extra] = ciphertext.split('.')
    if (version !== 'v1' || extra || !iv || !encrypted) throw Error('invalid')
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: encoder.encode(accountId) }, await encryptionKey(secret), bytes(encrypted))
    return new TextDecoder().decode(plain)
  } catch { throw new PublicError('Encrypted Instagram credential could not be loaded') }
}
export async function credentialRecord(store: Store): Promise<Credential | null> {
  return (await store.rows<Credential>('SELECT * FROM @schema.credentials WHERE account_id = $1', [store.accountId]))[0] ?? null
}
export async function activeToken(env: Env, store: Store) {
  if (!env.META_TOKEN_ENCRYPTION_KEY) {
    if (!env.META_ACCESS_TOKEN) throw new PublicError('Instagram token is not configured')
    return env.META_ACCESS_TOKEN
  }
  const record = await credentialRecord(store)
  // Once enabled, never silently fall back to a stale deployment secret.
  if (!record) throw new PublicError('Initialize the encrypted Instagram credential before deployment')
  return decryptToken(record.ciphertext, env.META_TOKEN_ENCRYPTION_KEY, env.IG_ACCOUNT_ID)
}
export function tokenMetadata(record: Credential | null, now: number) {
  return {
    storage: record ? 'encrypted_database' : 'deployment_secret',
    automaticRenewal: Boolean(record),
    revision: record?.revision ?? null,
    expiresAt: record?.expires_at ?? null,
    expiryVerified: record?.expires_at !== null && record?.expires_at !== undefined,
    secondsUntilExpiry: record?.expires_at === null || !record ? null : record.expires_at - now,
    refreshEligibleAt: record?.refresh_not_before ?? null,
    nextAutomaticRefreshAt: record?.next_refresh_at ?? null,
    lastRefreshedAt: record?.refreshed_at ?? null,
    lastRefreshError: record?.last_refresh_error ?? null,
    lastRefreshErrorAt: record?.last_refresh_error_at ?? null,
    renewalInProgress: Boolean(record?.refresh_claim && record.refresh_lease_until > now),
  }
}
export async function refreshCredential(env: Env, store: Store, actor: string, now: number, automatic = false, fetcher: typeof fetch = fetch) {
  if (!env.META_TOKEN_ENCRYPTION_KEY) throw new PublicError('Encrypted credential storage is required for durable renewal')
  const claim = crypto.randomUUID()
  const [record] = await store.rows<Credential>(
    `UPDATE @schema.credentials SET refresh_claim = $2, refresh_lease_until = $3::double precision + 120
     WHERE account_id = $1 AND refresh_not_before <= $3 AND (expires_at IS NULL OR expires_at > $3)
     AND refresh_lease_until <= $3 AND ($4 = FALSE OR next_refresh_at <= $3) RETURNING *`,
    [store.accountId, claim, now, automatic],
  )
  if (!record) {
    const current = await credentialRecord(store)
    return { outcome: 'deferred', reason: current?.expires_at && current.expires_at <= now ? 'expired_reauthorization_required' : current?.refresh_lease_until && current.refresh_lease_until > now ? 'renewal_in_progress' : 'not_due_or_younger_than_24_hours', ...tokenMetadata(current, now) }
  }
  try {
    const token = await decryptToken(record.ciphertext, env.META_TOKEN_ENCRYPTION_KEY, env.IG_ACCOUNT_ID)
    const url = new URL('https://graph.instagram.com/refresh_access_token')
    url.searchParams.set('grant_type', 'ig_refresh_token')
    // Meta requires the token in this server-side query. Never log this URL.
    url.searchParams.set('access_token', token)
    const parsed = z.object({ access_token: z.string().min(20).max(8192), token_type: z.literal('bearer'), expires_in: z.number().int().min(86401).max(90 * 86400) }).safeParse(await providerRequest(url, token, fetcher))
    if (!parsed.success) throw new ProviderError('invalid_response')
    await verifyAccount(env, parsed.data.access_token, fetcher)
    const encrypted = await encryptToken(parsed.data.access_token, env.META_TOKEN_ENCRYPTION_KEY, env.IG_ACCOUNT_ID)
    const expiresAt = now + parsed.data.expires_in
    const nextRefresh = Math.max(now + 86400, expiresAt - 7 * 86400)
    const changed = await store.rows<Credential>(
      `WITH changed AS (UPDATE @schema.credentials SET ciphertext = $3, revision = revision + 1,
       expires_at = $4::double precision, refreshed_at = $5::double precision,
       refresh_not_before = $5::double precision + 86400, next_refresh_at = $6::double precision,
       refresh_claim = NULL, refresh_lease_until = 0, last_refresh_error = NULL, last_refresh_error_at = NULL
       WHERE account_id = $1 AND refresh_claim = $2 AND revision = $7 RETURNING *), audit AS (
       INSERT INTO @schema.credential_operations(account_id,operation,actor,changed_at,revision)
       SELECT account_id,'refresh_succeeded',$8,$5::double precision,revision FROM changed) SELECT * FROM changed`,
      [store.accountId, claim, encrypted, expiresAt, now, nextRefresh, record.revision, actor],
    )
    if (changed.length !== 1) throw new PublicError('Credential revision changed during renewal')
    return { outcome: 'refreshed', ...tokenMetadata(changed[0], now) }
  } catch (error) {
    const reason = error instanceof ProviderError ? `${error.category}${error.code === undefined ? '' : `:${error.code}`}` : 'renewal_validation_or_storage_failed'
    await store.rows(`WITH changed AS (UPDATE @schema.credentials SET refresh_claim = NULL, refresh_lease_until = 0,
      next_refresh_at = $3::double precision + 3600, last_refresh_error = $4, last_refresh_error_at = $3
      WHERE account_id = $1 AND refresh_claim = $2 RETURNING *), audit AS (
      INSERT INTO @schema.credential_operations(account_id,operation,actor,changed_at,revision)
      SELECT account_id,'refresh_failed:' || $4,$5,$3,revision FROM changed) SELECT account_id FROM changed`,
      [store.accountId, claim, now, reason, actor])
    // Keep the last usable credential on any provider/validation/persistence error.
    throw new PublicError(`Instagram token renewal failed: ${reason}. Check get_token_status before trying again.`)
  }
}
