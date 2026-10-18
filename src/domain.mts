import { z } from 'zod'

export const idSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,150}$/)
const epoch = z.number().int().nonnegative()
export const ruleDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
    matchMode: z.enum(['whole_word', 'exact']).default('whole_word'),
    ignoreAccents: z.boolean().default(false),
    allowTrailingLetterRepeat: z.boolean().default(false)
      .describe('Allow extra copies of the final letter of a keyword, such as QUERO matching querooo. Other letters and word boundaries remain strict.'),
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('all') }).strict(),
      z
        .object({
          kind: z.literal('selected'),
          mediaIds: z.array(idSchema).min(1).max(100),
        })
        .strict(),
    ]),
    replyText: z.string().trim().min(1).max(1000),
    publicReplyText: z.string().trim().min(1).max(500).optional(),
    priority: z.number().int().min(-1000).max(1000).default(0),
    cooldownSeconds: z.number().int().min(0).max(604800).default(86400)
      .describe('Minimum interval between DMs to the same person on the same post. Other posts have independent cooldowns.'),
    startsAt: epoch.optional(),
    endsAt: epoch.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (
      rule.startsAt !== undefined &&
      rule.endsAt !== undefined &&
      rule.startsAt >= rule.endsAt
    ) {
      ctx.addIssue({ code: 'custom', message: 'endsAt must be after startsAt' })
    }
    if (
      rule.keywords.some(
        (word) => !normalize(word, rule.ignoreAccents).match(/[\p{L}\p{N}]/u),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Keywords must contain a letter or number',
      })
    }
  })
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>
export interface Rule {
  id: string
  account_id: string
  revision: number
  enabled: boolean
  definition: RuleDefinition
  created_at: number
  updated_at: number
  actor: string
}
export interface Comment {
  accountId: string
  commentId: string
  commenterId: string
  mediaId: string
  text: string
  timestamp: number
}
export type EventState =
  | 'pending'
  | 'retry'
  | 'sending'
  | 'provider_accepted'
  | 'send_unknown'
  | 'skipped'
  | 'blocked'
  | 'failed'
  | 'canceled'
export interface EventRecord {
  id: string
  account_id: string
  comment_id: string
  commenter_id: string
  media_id: string
  comment_text: string
  comment_at: number
  received_at: number
  expires_at: number
  rule_id: string | null
  rule_revision: number | null
  reply_text: string | null
  public_reply_text?: string | null
  cooldown_seconds: number
  state: EventState
  reason: string
  attempts: number
  max_attempts: number
  safe_to_retry: boolean
  next_attempt_at: number
  next_enqueue_at: number
  queued_at: number | null
  claim_token: string | null
  sending_started_at: number | null
  updated_at: number
  provider_message_id: string | null
  provider_recipient_id: string | null
  provider_error_code: number | null
  provider_error_subcode: number | null
}
export interface AccountSettings {
  paused: boolean
  revision: number
  updated_at: number
  last_webhook_at: number | null
  last_recovery_at: number | null
}
export interface Job {
  eventId: string
  kind?: 'public_reply'
}
export interface PublicReplyRecord {
  event_id: string
  account_id: string
  comment_id: string
  reply_text: string
  state: EventState
  reason: string
  attempts: number
  max_attempts: number
  expires_at: number
  claim_token: string | null
  sending_started_at: number | null
  next_attempt_at: number
  next_enqueue_at: number
  updated_at: number
  provider_reply_id: string | null
}
export interface Env {
  DATABASE_URL: string
  REPLIES: Queue<Job>
  IG_ACCOUNT_ID: string
  META_API_VERSION: string
  META_APP_SECRET?: string
  META_VERIFY_TOKEN?: string
  META_ACCESS_TOKEN?: string
  META_TOKEN_ENCRYPTION_KEY?: string
  LIVE_SENDS?: string
  RETENTION_DAYS?: string
  OPERATOR_NAME?: string
  OPERATOR_CONTACT_URL?: string
  DLQ_NAME?: string
  MCP_ADMIN_TOKEN?: string
  MCP_READ_TOKEN?: string
  MCP_CONFIGURE_TOKEN?: string
  MCP_OPERATE_TOKEN?: string
}
export class PublicError extends Error {}
export const secondsNow = () => Math.floor(Date.now() / 1000)
// A minute of margin at Meta's seven-day boundary.
export const replyDeadline = (timestamp: number) => timestamp + 7 * 86400 - 60
export function normalize(text: string, ignoreAccents: boolean): string {
  const normalized = text
    .normalize('NFKC')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/gu, ' ')
    .trim()
  return ignoreAccents
    ? normalized.normalize('NFD').replace(/\p{M}/gu, '')
    : normalized
}
function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
export function matchRule(
  rule: Rule,
  text: string,
  mediaId: string,
  timestamp: number,
): string {
  const d = rule.definition
  if (!rule.enabled) return 'disabled'
  if (d.scope.kind === 'selected' && !d.scope.mediaIds.includes(mediaId))
    return 'media_out_of_scope'
  if (d.startsAt !== undefined && timestamp < d.startsAt) return 'not_started'
  if (d.endsAt !== undefined && timestamp >= d.endsAt) return 'ended'
  const normalized = normalize(text, d.ignoreAccents)
  const matched = d.keywords.some((keyword) => {
    const key = normalize(keyword, d.ignoreAccents)
    const finalLetter = Array.from(key).at(-1)
    const extension = d.allowTrailingLetterRepeat && finalLetter && /^\p{L}$/u.test(finalLetter)
      ? `${escapeRegex(finalLetter)}*`
      : ''
    const pattern = escapeRegex(key) + extension
    return d.matchMode === 'exact'
      ? new RegExp(`^(?:${pattern})$`, 'u').test(normalized)
      : new RegExp(
          `(?:^|[^\\p{L}\\p{N}_])${pattern}(?=$|[^\\p{L}\\p{N}_])`,
          'u',
        ).test(normalized)
  })
  return matched ? 'matched' : 'keyword_not_matched'
}
export function preview(
  rules: Rule[],
  text: string,
  mediaId: string,
  timestamp: number,
) {
  const ordered = [...rules].sort(
    (a, b) =>
      b.definition.priority - a.definition.priority ||
      a.id.localeCompare(b.id, 'en'),
  )
  const decisions = ordered.map((rule) => ({
    ruleId: rule.id,
    revision: rule.revision,
    reason: matchRule(rule, text, mediaId, timestamp),
  }))
  const winner = ordered.find((_, i) => decisions[i].reason === 'matched')
  return { winner, decisions }
}
export function sendConfigured(env: Env) {
  return Boolean(
    (env.META_ACCESS_TOKEN || env.META_TOKEN_ENCRYPTION_KEY) &&
      env.META_APP_SECRET &&
      env.IG_ACCOUNT_ID &&
      /^v\d+\.\d+$/.test(env.META_API_VERSION),
  )
}
