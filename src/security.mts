import type { Env } from './domain.mts'
export type Permission = 'read' | 'configure' | 'operate'
export interface Identity {
  actor: string
  permissions: Set<Permission>
}
const encoder = new TextEncoder()
export async function equalSecret(a: string, b: string) {
  const [x, y] = await Promise.all(
    [a, b].map(
      async (s) =>
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', encoder.encode(s)),
        ),
    ),
  )
  let difference = 0
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i]
  return difference === 0
}
export async function authenticate(
  request: Request,
  env: Env,
): Promise<Identity | null> {
  const origin = request.headers.get('Origin')
  if (origin && origin !== new URL(request.url).origin) return null
  const bearer = request.headers
    .get('Authorization')
    ?.match(/^Bearer ([^\s]+)$/i)?.[1]
  if (!bearer) return null
  const choices: [string, string | undefined, Permission[]][] = [
    ['owner', env.MCP_ADMIN_TOKEN, ['read', 'configure', 'operate']],
    ['reader', env.MCP_READ_TOKEN, ['read']],
    ['configurer', env.MCP_CONFIGURE_TOKEN, ['read', 'configure']],
    ['operator', env.MCP_OPERATE_TOKEN, ['read', 'operate']],
  ]
  for (const [actor, token, permissions] of choices) {
    if (token && token.length >= 32 && (await equalSecret(bearer, token)))
      return { actor, permissions: new Set(permissions) }
  }
  return null
}
export async function verifySignature(
  body: string,
  signature: string | null,
  secret: string | undefined,
) {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const bytes = Uint8Array.from(
    signature.slice(7).match(/.{2}/g) ?? [],
    (pair) => parseInt(pair, 16),
  )
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(body))
}
export async function readBody(
  request: Pick<Request, 'headers' | 'body'>,
  limit = 512 * 1024,
): Promise<string> {
  if (Number(request.headers.get('content-length') ?? 0) > limit)
    throw new Error('body_too_large')
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    length += result.value.length
    if (length > limit) {
      await reader.cancel()
      throw new Error('body_too_large')
    }
    chunks.push(result.value)
  }
  const all = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all)
}
