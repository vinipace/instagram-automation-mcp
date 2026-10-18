import { z } from 'zod'
import { type Env, PublicError } from './domain.mts'
import { readBody } from './security.mts'

export class ProviderError extends PublicError {
  readonly category: 'permission_or_token' | 'rate_limit' | 'unavailable' | 'rejected' | 'invalid_response'
  readonly code?: number
  readonly subcode?: number
  constructor(
    category: 'permission_or_token' | 'rate_limit' | 'unavailable' | 'rejected' | 'invalid_response',
    code?: number,
    subcode?: number,
  ) {
    super(`Instagram request failed: ${category}${code === undefined ? '' : ` (code ${code}${subcode === undefined ? '' : `/${subcode}`})`}`)
    this.category = category
    this.code = code
    this.subcode = subcode
  }
}
export async function providerGet(
  env: Env, token: string, path: string, params: Record<string, string> = {}, fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (!/^v\d+\.\d+$/.test(env.META_API_VERSION) || !/^[A-Za-z0-9_/-]+$/.test(path))
    throw new PublicError('Invalid provider configuration')
  const url = new URL(`https://graph.instagram.com/${env.META_API_VERSION}/${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return providerRequest(url, token, fetcher)
}
export async function providerRequest(url: URL, token: string, fetcher: typeof fetch): Promise<unknown> {
  if (url.hostname !== 'graph.instagram.com' || url.protocol !== 'https:')
    throw new PublicError('Invalid provider host')
  let response: Response
  let body: unknown
  try {
    response = await fetcher(url.toString(), {
      method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    })
    body = JSON.parse(await readBody(response, 256 * 1024))
  } catch { throw new ProviderError('unavailable') }
  if (!response.ok) {
    const error = z.object({ error: z.object({ code: z.number().int(), error_subcode: z.number().int().optional() }) }).safeParse(body)
    const code = error.success ? error.data.error.code : undefined
    const subcode = error.success ? error.data.error.error_subcode : undefined
    const category = response.status === 401 || response.status === 403 || [10, 190, 200].includes(code ?? -1)
      ? 'permission_or_token' : response.status === 429 || [4, 17, 32, 613].includes(code ?? -1)
        ? 'rate_limit' : response.status >= 500 || response.status < 400 ? 'unavailable' : 'rejected'
    // Never return raw error text, URLs, paging links, or credentials.
    throw new ProviderError(category, code, subcode)
  }
  return body
}
export const accountSchema = z.object({
  id: z.string(), user_id: z.string(), username: z.string(), account_type: z.string(),
})
export async function verifyAccount(env: Env, token: string, fetcher: typeof fetch = fetch) {
  const parsed = accountSchema.safeParse(await providerGet(env, token, 'me', { fields: 'id,user_id,username,account_type' }, fetcher))
  if (!parsed.success) throw new ProviderError('invalid_response')
  if (parsed.data.user_id !== env.IG_ACCOUNT_ID) throw new PublicError('Authorized token belongs to a different Instagram account')
  return parsed.data
}
