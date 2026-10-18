import { appendFile, chmod } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { localEnv } from './local-env.mts'
import { Store } from '../src/store.mts'
import { credentialRecord, decryptToken, encryptToken } from '../src/credentials.mts'
import { verifyAccount } from '../src/provider.mts'
import type { Env } from '../src/domain.mts'

let stage = 'configuration'
try {
  const env = await localEnv()
  if (!env.DATABASE_URL || !env.META_ACCESS_TOKEN || !env.IG_ACCOUNT_ID) throw Error('configuration')
  const store = new Store(env.DATABASE_URL, env.IG_ACCOUNT_ID)
  stage = 'credential table'
  const existing = await credentialRecord(store)
  if (!env.META_TOKEN_ENCRYPTION_KEY) {
    if (existing) throw Error('Restore the existing encryption key; do not create another key')
    const key = Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('')
    const file = new URL('../.dev.vars', import.meta.url)
    await appendFile(file, `\nMETA_TOKEN_ENCRYPTION_KEY=${key}\n`, { mode: 0o600 })
    await chmod(file, 0o600)
    env.META_TOKEN_ENCRYPTION_KEY = key
  }
  if (existing) {
    await verifyAccount(env as unknown as Env, await decryptToken(existing.ciphertext, env.META_TOKEN_ENCRYPTION_KEY, env.IG_ACCOUNT_ID))
    console.log('Existing encrypted credential verified; no token was replaced.')
  } else {
    stage = 'account verification'
    await verifyAccount(env as unknown as Env, env.META_ACCESS_TOKEN)
    const now = Math.floor(Date.now() / 1000)
    const ciphertext = await encryptToken(env.META_ACCESS_TOKEN, env.META_TOKEN_ENCRYPTION_KEY, env.IG_ACCOUNT_ID)
    stage = 'encrypted credential insert'
    const result = await store.rows<{ account_id: string }>(`WITH created AS (
      INSERT INTO @schema.credentials(account_id,ciphertext,stored_at,refresh_not_before,next_refresh_at)
      VALUES($1,$2,$3::double precision,$3::double precision+86400,$3::double precision+86400) ON CONFLICT DO NOTHING RETURNING *), audit AS (
      INSERT INTO @schema.credential_operations(account_id,operation,actor,changed_at,revision)
      SELECT account_id,'bootstrap_existing_authorization','owner',$3,revision FROM created)
      SELECT account_id FROM created`, [env.IG_ACCOUNT_ID, ciphertext, now])
    if (result.length !== 1) throw Error('concurrent initialization')
    console.log('Existing authorization encrypted and initialized. Exact expiry is unknown until refresh; renewal waits at least 24 hours.')
  }
} catch (error) {
  console.error('Credential initialization failed. Verify migration, account authorization and private encryption-key backup; secrets are not printed.')
  console.error(JSON.stringify({ stage, code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code).slice(0,10) : null }))
  process.exitCode = 1
}
