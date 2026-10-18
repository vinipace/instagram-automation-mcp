import { readFile, writeFile, chmod, access } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function initializeConfig(root = new URL('../', import.meta.url)) {
  for (const name of ['.dev.vars','wrangler.local.jsonc']) {
    let exists = false
    try { await access(new URL(name, root)); exists = true } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    if (exists) throw new Error('Existing private configuration is never overwritten')
  }
  const deployment = await readFile(new URL('wrangler.jsonc', root), 'utf8')
  let source = await readFile(new URL('.dev.vars.example', root), 'utf8')
  for (const key of ['MCP_ADMIN_TOKEN','MCP_READ_TOKEN','MCP_CONFIGURE_TOKEN','MCP_OPERATE_TOKEN','META_VERIFY_TOKEN','META_TOKEN_ENCRYPTION_KEY']) {
    const value = Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('')
    source = source.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
  }
  source = source.replace(/^META_API_VERSION=.*$/m, 'META_API_VERSION=v26.0')
    .replace(/^LIVE_SENDS=.*$/m, 'LIVE_SENDS=false')
  const destination = new URL('.dev.vars', root)
  await writeFile(destination, source, { flag: 'wx', mode: 0o600 })
  await chmod(destination, 0o600)
  await writeFile(new URL('wrangler.local.jsonc', root), deployment, { flag: 'wx', mode: 0o600 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await initializeConfig()
    console.log('Created private .dev.vars and wrangler.local.jsonc with independent random credentials and LIVE_SENDS=false. Fill your own database, Instagram and operator settings; secrets were not printed.')
  } catch {
    console.error('Configuration was not created. An existing .dev.vars is never overwritten; verify the example file and directory permissions.')
    process.exitCode = 1
  }
}
