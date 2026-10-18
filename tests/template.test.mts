import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile, mkdtemp, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { initializeConfig } from '../scripts/init-config.mts'
import { renderPrivacyPage } from '../src/privacy.mts'

const root = new URL('../', import.meta.url)
test('published deployment defaults have no account affinity and cannot enable live sends', async () => {
  const config = JSON.parse(await readFile(new URL('wrangler.jsonc', root), 'utf8'))
  assert.equal(config.account_id, undefined)
  assert.equal(config.vars.IG_ACCOUNT_ID, '')
  assert.equal(config.vars.LIVE_SENDS, 'false')
  assert.equal(config.vars.OPERATOR_NAME, '')
  assert.equal(config.vars.OPERATOR_CONTACT_URL, '')
  assert.equal(config.queues.consumers[0].dead_letter_queue, config.queues.consumers[1].queue)
  assert.equal(config.queues.producers[0].queue, config.queues.consumers[0].queue)
  const verifier = await readFile(new URL('scripts/verify-deployment.mts', root), 'utf8')
  assert(!verifier.includes('.workers.dev'))
})
test('initial setup generates separate private credentials and never overwrites either configuration file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'instagram-config-test-'))
  const location = pathToFileURL(directory + '/')
  try {
    for (const file of ['.dev.vars.example', 'wrangler.jsonc'])
      await writeFile(new URL(file, location), await readFile(new URL(file, root)))
    await initializeConfig(location)
    const original = await readFile(new URL('.dev.vars', location), 'utf8')
    const values = Object.fromEntries(original.split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
      const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]
    }))
    const credentials = ['MCP_ADMIN_TOKEN','MCP_READ_TOKEN','MCP_CONFIGURE_TOKEN','MCP_OPERATE_TOKEN','META_VERIFY_TOKEN','META_TOKEN_ENCRYPTION_KEY'].map(key => values[key])
    assert(credentials.every(value => /^[a-f0-9]{64}$/.test(value)))
    assert.equal(new Set(credentials).size, credentials.length)
    assert.equal(values.DATABASE_URL, '')
    assert.equal(values.META_ACCESS_TOKEN, '')
    assert.equal(values.LIVE_SENDS, 'false')
    if (process.platform !== 'win32') assert.equal((await stat(new URL('.dev.vars', location))).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(new URL('wrangler.local.jsonc', location), 'utf8')).vars.LIVE_SENDS, 'false')
    await assert.rejects(initializeConfig(location))
    assert.equal(await readFile(new URL('.dev.vars', location), 'utf8'), original)
    await rm(new URL('.dev.vars', location))
    await assert.rejects(initializeConfig(location))
    await assert.rejects(readFile(new URL('.dev.vars', location)))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('operator notices require a real configuration, escape HTML and follow the configured retention', () => {
  assert.equal(renderPrivacyPage({}, 30), null)
  for (const url of ['javascript:alert(1)','http://example.invalid/contact','https://user:password@example.invalid'])
    assert.equal(renderPrivacyPage({OPERATOR_NAME:'Test operator',OPERATOR_CONTACT_URL:url},30),null)
  const page = renderPrivacyPage({OPERATOR_NAME:'Test <operator> & "team"',OPERATOR_CONTACT_URL:'https://example.invalid/contact?a=1&b=2'},45)!
  assert(page.includes('Test &lt;operator&gt; &amp; &quot;team&quot;'))
  assert(!page.includes('Test <operator>'))
  assert(page.includes('45 dias'))
  assert(page.includes('a=1&amp;b=2'))
  assert.equal(renderPrivacyPage({OPERATOR_NAME:'Test',OPERATOR_CONTACT_URL:'https://example.invalid'},7),null)
})
test('a fresh Worker boots in the actual Cloudflare runtime without credentials or production requests', async () => {
  const bundle = await build({entryPoints:[fileURLToPath(new URL('../src/worker.mts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2023',external:['node:*']})
  const config = JSON.parse(await readFile(new URL('wrangler.jsonc', root), 'utf8'))
  let outboundCalls = 0
  const runtime = new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,bindings:config.vars,outboundService:async()=>{outboundCalls++;throw new Error('Fresh template must not make external requests')}}))
  try {
    const health=await runtime.dispatchFetch('http://template.test/health')
    assert.equal(health.status,200)
    assert.equal((await health.json() as {service:string}).service,'instagram-automation-mcp')
    assert.equal((await runtime.dispatchFetch('http://template.test/mcp')).status,401)
    assert.equal((await runtime.dispatchFetch('http://template.test/webhooks/instagram',{method:'POST',body:'{}'})).status,503)
    assert.equal((await runtime.dispatchFetch('http://template.test/privacy')).status,503)
    assert.equal(outboundCalls,0)
  } finally { await runtime.dispose() }
})
