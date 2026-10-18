import { readFile } from 'node:fs/promises'
import { neon } from '@neondatabase/serverless'
import { localEnv } from './local-env.mts'

const env = await localEnv()
if (!env.DATABASE_URL)
  throw new Error('Set DATABASE_URL in .dev.vars or the environment')
try {
  const sql = neon(env.DATABASE_URL)
  const [table] = await sql.query("SELECT to_regclass('instagram_automation.schema_migrations') AS ledger")
  const applied = table.ledger ? await sql.query('SELECT version FROM instagram_automation.schema_migrations ORDER BY version') : []
  const migrations = [[1, '0001_initial.sql'], [2, '0002_reliability.sql'], [3, '0003_public_replies.sql'], [4, '0004_post_cooldowns.sql']] as const
  for (const [version, file] of migrations) {
    if (applied.some(row => row.version === version)) continue
    const source = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
    const statements = source.split(';').map(s => s.trim()).filter(Boolean)
    await sql.transaction(statements.map(statement => sql.query(statement)), { fetchOptions: { signal: AbortSignal.timeout(30000) } })
    console.log(`Applied migration ${version} in the dedicated instagram_automation schema.`)
  }
  console.log('Service migrations are current. Existing rules and account sending settings were preserved.')
} catch {
  console.error(
    'Migration failed. Verify database connectivity and schema-creation permission. Credentials are not printed.',
  )
  process.exitCode = 1
}
