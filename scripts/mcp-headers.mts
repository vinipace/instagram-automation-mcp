import { localEnv } from './local-env.mts'

// Intended for Codex's http_headers_helper. stdout contains a credential.
const env = await localEnv()
if (!env.MCP_ADMIN_TOKEN || /[\r\n]/.test(env.MCP_ADMIN_TOKEN)) {
  console.error('Instagram MCP owner credential is unavailable.')
  process.exit(1)
}
process.stdout.write(
  JSON.stringify({ Authorization: `Bearer ${env.MCP_ADMIN_TOKEN}` }),
)
