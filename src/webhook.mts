import { z } from 'zod'
import { idSchema, type Comment, PublicError } from './domain.mts'
const maxNotifications = 1000
const entrySchema = z
  .object({
    id: idSchema,
    time: z.number().int().positive(),
    changes: z
      .array(z.object({ field: z.string(), value: z.unknown() }))
      .max(maxNotifications)
      .optional(),
    field: z.string().min(1).optional(),
    value: z.unknown(),
  })
  // Instagram Login also puts field/value directly on the entry. Reject
  // ambiguous entries rather than silently choosing one representation.
  .refine(
    (entry) => (entry.changes !== undefined) !== (entry.field !== undefined),
  )
const payloadSchema = z.object({
  object: z.literal('instagram'),
  entry: z.array(entrySchema).max(maxNotifications),
})
const commentValue = z.object({
  id: idSchema,
  text: z.string().max(10000),
  from: z.object({ id: idSchema }),
  media: z.object({ id: idSchema, media_product_type: z.string().optional() }),
})
export function parseComments(
  payload: unknown,
  accountId: string,
  now: number,
): Comment[] {
  // Meta's examples include a single envelope and arrays of envelopes. The
  // original request bytes are authenticated before this normalization.
  const parsed = z
    .array(payloadSchema)
    .min(1)
    .max(maxNotifications)
    .safeParse(Array.isArray(payload) ? payload : [payload])
  if (!parsed.success)
    throw new PublicError('Invalid Instagram webhook envelope')
  const comments: Comment[] = []
  const entries = parsed.data.flatMap((envelope) => envelope.entry)
  if (entries.length > maxNotifications)
    throw new PublicError('Webhook batch exceeds 1000 entries')
  let notifications = 0
  for (const entry of entries) {
    const changes =
      entry.changes ?? [{ field: entry.field!, value: entry.value }]
    notifications += changes.length
    if (notifications > maxNotifications)
      throw new PublicError('Webhook batch exceeds 1000 notifications')
    if (entry.id !== accountId) continue
    if (entry.time > now + 300)
      throw new PublicError('Webhook event time is in the future')
    for (const change of changes) {
      if (change.field !== 'comments') continue
      const result = commentValue.safeParse(change.value)
      if (!result.success)
        throw new PublicError('Invalid comment webhook value')
      const value = result.data
      if (value.media.media_product_type === 'LIVE') continue
      comments.push({
        accountId,
        commentId: value.id,
        commenterId: value.from.id,
        mediaId: value.media.id,
        text: value.text,
        timestamp: entry.time,
      })
    }
  }
  return comments
}
