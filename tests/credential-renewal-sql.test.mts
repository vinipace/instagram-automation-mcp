import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { Store } from '../src/store.mts'
import { type Env } from '../src/domain.mts'
import { credentialRecord, decryptToken, encryptToken, refreshCredential } from '../src/credentials.mts'

// Run the production renewal SQL against an isolated in-memory PostgreSQL engine.
const db = new PGlite()
const schema = 'ig_test_renewal'
const account = '10000002'
const now = 1700000000
const store = new Store('postgresql://test@localhost/test', account, schema)
Object.defineProperty(store, 'sql', { value: {
  query(text: string, values: unknown[] = []) {
    return { text, values, then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
      return db.query(text, values).then(result => ({ rows: result.rows, rowCount: result.affectedRows })).then(resolve, reject)
    } }
  },
} })
const env = { IG_ACCOUNT_ID: account, META_API_VERSION: 'v26.0', META_TOKEN_ENCRYPTION_KEY: 'cd'.repeat(32) } as unknown as Env
const fetcher = (async (url: unknown) => new URL(String(url)).pathname === '/refresh_access_token'
  ? Response.json({ access_token: 'refreshed-token-long-enough', token_type: 'bearer', expires_in: 60 * 86400 })
  : Response.json({ id: 'app-scoped', user_id: account, username: 'test-owner', account_type: 'BUSINESS' })) as typeof fetch

before(async () => {
  for (const file of ['0001_initial.sql','0002_reliability.sql','0003_public_replies.sql','0004_post_cooldowns.sql'])
    await db.exec((await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')).replaceAll('instagram_automation', schema))
  await store.rows(
    `INSERT INTO @schema.credentials(account_id,ciphertext,stored_at,refresh_not_before,next_refresh_at) VALUES ($1,$2,$3::double precision,$3::double precision,$3::double precision)`,
    [account, await encryptToken('original-token-long-enough', env.META_TOKEN_ENCRYPTION_KEY!, account), now - 2 * 86400],
  )
})
after(async () => { await db.close() })

test('automatic renewal persists the refreshed credential with real PostgreSQL', async () => {
  const result = await refreshCredential(env, store, 'automatic_renewal', now, true, fetcher)
  assert.equal(result.outcome, 'refreshed')
  const record = (await credentialRecord(store))!
  assert.equal(record.revision, 2)
  assert.equal(record.expires_at, now + 60 * 86400)
  assert.equal(record.next_refresh_at, now + 53 * 86400)
  assert.equal(record.last_refresh_error, null)
  assert.equal(await decryptToken(record.ciphertext, env.META_TOKEN_ENCRYPTION_KEY!, account), 'refreshed-token-long-enough')
  const [audit] = await store.rows<{ operation: string; actor: string }>('SELECT operation, actor FROM @schema.credential_operations WHERE account_id = $1', [account])
  assert.deepEqual({ ...audit }, { operation: 'refresh_succeeded', actor: 'automatic_renewal' })
})
