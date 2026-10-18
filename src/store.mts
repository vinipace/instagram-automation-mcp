import { neon } from '@neondatabase/serverless'
import {
  type AccountSettings,
  type Comment,
  type EventRecord,
  type EventState,
  type PublicReplyRecord,
  type Rule,
  type RuleDefinition,
  matchRule,
  preview,
  PublicError,
  replyDeadline,
} from './domain.mts'

export interface Outcome {
  state: EventState
  reason: string
  safeToRetry?: boolean
  nextAttemptAt?: number
  messageId?: string
  recipientId?: string
  errorCode?: number
  errorSubcode?: number
}
export class Store {
  readonly accountId: string
  readonly schema: string
  private sql: ReturnType<typeof neon<false, true>>
  constructor(
    databaseUrl: string,
    accountId: string,
    schema = 'instagram_automation',
  ) {
    if (!/^(instagram_automation|ig_test_[a-z0-9_]+)$/.test(schema))
      throw new Error('Invalid service schema')
    this.accountId = accountId
    this.schema = schema
    this.sql = neon(databaseUrl, { fullResults: true })
  }
  async rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
    return (
      await this.sql.query(text.replaceAll('@schema', this.schema), values, {
        fetchOptions: { signal: AbortSignal.timeout(15000) },
      })
    ).rows as T[]
  }
  private async batch(queries: [string, unknown[]][]) {
    return this.sql.transaction(
      queries.map(([text, values]) =>
        this.sql.query(text.replaceAll('@schema', this.schema), values),
      ),
      { fetchOptions: { signal: AbortSignal.timeout(20000) } },
    )
  }
  async settings(): Promise<AccountSettings> {
    const [settings] = await this.rows<AccountSettings>(
      'SELECT * FROM @schema.account_settings WHERE id = 1',
    )
    if (!settings)
      throw new PublicError('Apply the service database migration first')
    return settings
  }
  async listRules(): Promise<Rule[]> {
    const rows = await this.rows<Rule>(
      'SELECT * FROM @schema.rules WHERE account_id = $1 ORDER BY id LIMIT 201',
      [this.accountId],
    )
    if (rows.length > 200)
      throw new PublicError('This v1 supports at most 200 rules per account')
    return rows
  }
  async getRule(id: string): Promise<Rule> {
    const [rule] = await this.rows<Rule>(
      'SELECT * FROM @schema.rules WHERE id = $1 AND account_id = $2',
      [id, this.accountId],
    )
    if (!rule) throw new PublicError('Rule not found')
    return rule
  }
  async createRule(
    definition: RuleDefinition,
    actor: string,
    now: number,
  ): Promise<Rule> {
    const results = await this.batch([
      ['SELECT id FROM @schema.account_settings WHERE id = 1 FOR UPDATE', []],
      [
        `WITH changed AS (
      INSERT INTO @schema.rules SELECT $1, $2, 1, FALSE, $3::jsonb, $4, $4, $5
        WHERE (SELECT count(*) FROM @schema.rules WHERE account_id = $2) < 200 RETURNING *
    ), history AS (
      INSERT INTO @schema.rule_history SELECT id, revision, enabled, definition, actor, updated_at FROM changed
    ) SELECT * FROM changed`,
        [
          crypto.randomUUID(),
          this.accountId,
          JSON.stringify(definition),
          now,
          actor,
        ],
      ],
    ])
    const rule = results[1].rows[0] as Rule | undefined
    if (!rule) throw new PublicError('Rule limit reached')
    return rule
  }
  async updateRule(
    id: string,
    revision: number,
    definition: RuleDefinition | null,
    enabled: boolean | null,
    actor: string,
    now: number,
  ): Promise<Rule> {
    const [rule] = await this.rows<Rule>(
      `WITH changed AS (
      UPDATE @schema.rules SET revision = revision + 1, definition = COALESCE($4::jsonb, definition),
        enabled = COALESCE($5::boolean, enabled), actor = $6, updated_at = $7
      WHERE id = $1 AND account_id = $2 AND revision = $3 RETURNING *
    ), history AS (
      INSERT INTO @schema.rule_history SELECT id, revision, enabled, definition, actor, updated_at FROM changed
    ), canceled AS (
      UPDATE @schema.events SET state = 'canceled', reason = 'rule_disabled', updated_at = $7
      WHERE state IN ('pending', 'retry') AND rule_id IN (SELECT id FROM changed WHERE enabled = FALSE)
    ), canceled_public AS (
      UPDATE @schema.comment_replies p SET state='canceled',reason='rule_disabled',updated_at=$7
      FROM @schema.events e WHERE p.event_id=e.id AND p.state IN ('pending','retry')
        AND e.rule_id IN (SELECT id FROM changed WHERE enabled=FALSE)
    ) SELECT * FROM changed`,
      [
        id,
        this.accountId,
        revision,
        definition ? JSON.stringify(definition) : null,
        enabled,
        actor,
        now,
      ],
    )
    if (!rule)
      throw new PublicError(
        'Rule not found or revision conflict; read the latest rule and try again',
      )
    return rule
  }
  async ruleHistory(id: string, limit: number, beforeRevision: number) {
    await this.getRule(id)
    return this.rows(
      'SELECT * FROM @schema.rule_history WHERE rule_id = $1 AND revision < $2 ORDER BY revision DESC LIMIT $3',
      [id, beforeRevision, limit],
    )
  }
  async setPaused(
    paused: boolean,
    revision: number,
    actor: string,
    now: number,
  ) {
    const [settings] = await this.rows<AccountSettings>(
      `WITH changed AS (
      UPDATE @schema.account_settings SET paused = $1, revision = revision + 1, actor = $2, updated_at = $3
      WHERE id = 1 AND revision = $4 RETURNING *
    ), history AS (
      INSERT INTO @schema.account_history SELECT revision, paused, actor, updated_at FROM changed
    ) SELECT * FROM changed`,
      [paused, actor, now, revision],
    )
    if (!settings)
      throw new PublicError(
        'Account revision conflict; read health and try again',
      )
    return settings
  }
  async acceptComments(comments: Comment[], now: number) {
    if (!comments.length) return { inserted: 0, observed: 0 }
    const rules = await this.listRules()
    const inserts: [string, unknown[]][] = comments.map((c) => {
      const matched = preview(rules, c.text, c.mediaId, c.timestamp)
      const expired = replyDeadline(c.timestamp) <= now
      const ownComment = c.commenterId === this.accountId
      const winner = expired || ownComment ? undefined : matched.winner
      const reason = expired
        ? 'comment_expired'
        : ownComment
          ? 'own_comment'
          : winner
            ? 'matched'
            : 'no_matching_rule'
      return [
        `INSERT INTO @schema.events (
        id, account_id, comment_id, commenter_id, media_id, comment_text, comment_at, received_at, expires_at,
        rule_id, rule_revision, reply_text, public_reply_text, cooldown_seconds, state, reason, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$8)
      ON CONFLICT (account_id, comment_id) DO NOTHING RETURNING id`,
        [
          `${this.accountId}:${c.commentId}`,
          this.accountId,
          c.commentId,
          c.commenterId,
          c.mediaId,
          c.text,
          c.timestamp,
          now,
          replyDeadline(c.timestamp),
          winner?.id ?? null,
          winner?.revision ?? null,
          winner?.definition.replyText ?? null,
          winner?.definition.publicReplyText ?? null,
          winner?.definition.cooldownSeconds ?? 0,
          winner ? 'pending' : 'skipped',
          reason,
        ],
      ]
    })
    inserts.push([
      'UPDATE @schema.account_settings SET last_webhook_at = $1 WHERE id = 1',
      [now],
    ])
    const results = await this.batch(inserts)
    return {
      inserted: results
        .slice(0, -1)
        .reduce((sum, result) => sum + (result.rowCount ?? 0), 0),
      observed: comments.length,
    }
  }
  async getEvent(id: string): Promise<EventRecord> {
    const [event] = await this.rows<EventRecord>(
      'SELECT * FROM @schema.events WHERE id = $1 AND account_id = $2',
      [id, this.accountId],
    )
    if (!event) throw new PublicError('Event not found')
    return event
  }
  async reprocessTrailingLetterComment(
    id: string,
    expectedUpdatedAt: number,
    actor: string,
    now: number,
  ): Promise<EventRecord> {
    const event = await this.getEvent(id)
    const { winner } = preview(await this.listRules(), event.comment_text, event.media_id, event.comment_at)
    if (!winner?.definition.allowTrailingLetterRepeat || matchRule({
      ...winner, definition: { ...winner.definition, allowTrailingLetterRepeat: false },
    }, event.comment_text, event.media_id, event.comment_at) === 'matched') {
      throw new PublicError('Only a comment newly matching an enabled trailing-letter rule can be reprocessed')
    }
    const [changed] = await this.rows<EventRecord>(
      `WITH changed AS (
        UPDATE @schema.events e SET state='pending',reason='trailing_letter_reprocess',updated_at=$3,
          rule_id=$4,rule_revision=$5,reply_text=$6,public_reply_text=$7,cooldown_seconds=$8,
          next_attempt_at=$3,next_enqueue_at=$3,safe_to_retry=FALSE
        WHERE e.id=$1 AND e.account_id=$2 AND e.updated_at=$9 AND e.expires_at>$3
          AND e.state='skipped' AND e.reason='no_matching_rule' AND e.attempts=0
          AND e.rule_id IS NULL AND e.rule_revision IS NULL AND e.reply_text IS NULL AND e.public_reply_text IS NULL
          AND e.provider_message_id IS NULL AND e.provider_recipient_id IS NULL
          AND e.commenter_id<>e.account_id AND e.claim_token IS NULL AND e.queued_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM @schema.send_attempts a WHERE a.event_id=e.id)
          AND NOT EXISTS (SELECT 1 FROM @schema.comment_replies p WHERE p.event_id=e.id)
          AND NOT EXISTS (SELECT 1 FROM @schema.post_contact_gates g WHERE g.account_id=e.account_id
            AND g.media_id=e.media_id AND g.commenter_id=e.commenter_id AND g.next_allowed_at>$3)
          AND EXISTS (SELECT 1 FROM @schema.rules r WHERE r.id=$4 AND r.account_id=e.account_id
            AND r.enabled=TRUE AND r.revision=$5 AND r.definition=$10::jsonb)
        RETURNING e.*
      ), audit AS (
        INSERT INTO @schema.event_operations (event_id,operation,actor,changed_at)
        SELECT id,'reprocess_trailing_letter_repeat:no_matching_rule:zero_dispatch',$11,$3 FROM changed
      ) SELECT * FROM changed`,
      [id,this.accountId,now,winner.id,winner.revision,winner.definition.replyText,
        winner.definition.publicReplyText ?? null,winner.definition.cooldownSeconds,expectedUpdatedAt,
        JSON.stringify(winner.definition),actor],
    )
    if (!changed) throw new PublicError('Only an unsent, unexpired unmatched comment without an active post cooldown can be reprocessed; stale or already handled events are rejected')
    return changed
  }
  async eventAttempts(id: string) {
    await this.getEvent(id)
    return this.rows(
      'SELECT * FROM @schema.send_attempts WHERE event_id = $1 ORDER BY started_at DESC LIMIT 100',
      [id],
    )
  }
  async listEvents(
    limit: number,
    cursor: { time: number; id: string } | null,
    state: string | null,
    ruleId: string | null,
  ) {
    return this.rows<EventRecord>(
      `SELECT * FROM @schema.events WHERE account_id = $1
      AND ($2::text IS NULL OR state = $2) AND ($3::text IS NULL OR rule_id = $3)
      AND ($4::double precision IS NULL OR (received_at, id) < ($4, $5::text))
      ORDER BY received_at DESC, id DESC LIMIT $6`,
      [
        this.accountId,
        state,
        ruleId,
        cursor?.time ?? null,
        cursor?.id ?? null,
        limit,
      ],
    )
  }
  async stats(since: number, until: number) {
    const [states, byRule] = await Promise.all([
      this.rows(
        'SELECT state, reason, count(*)::int AS count FROM @schema.events WHERE account_id = $1 AND received_at >= $2 AND received_at < $3 GROUP BY state, reason ORDER BY state, reason',
        [this.accountId, since, until],
      ),
      this.rows(
        'SELECT rule_id, state, count(*)::int AS count FROM @schema.events WHERE account_id = $1 AND received_at >= $2 AND received_at < $3 GROUP BY rule_id, state ORDER BY rule_id, state LIMIT 2000',
        [this.accountId, since, until],
      ),
    ])
    return {
      since,
      until,
      states,
      byRule,
      coverage: 'observed_webhooks_only',
      acceptanceIsDelivery: false,
    }
  }
  async backlog(now: number) {
    return this.rows(
      `SELECT state, count(*)::int AS count, MIN(received_at) AS oldest_received_at,
       $2 - MIN(received_at) AS oldest_age_seconds,
       $2 - MIN(CASE WHEN state IN ('pending','retry') THEN GREATEST(received_at,next_attempt_at)
         WHEN state='sending' THEN COALESCE(sending_started_at,updated_at) ELSE updated_at END) AS oldest_actionable_age_seconds
       FROM @schema.events WHERE account_id = $1 GROUP BY state`,
      [this.accountId, now],
    )
  }
  async failures(limit: number, cursor: { time: number; id: string } | null, since: number, until: number, ruleId: string | null) {
    return this.rows<EventRecord>(
      `SELECT * FROM @schema.events WHERE account_id=$1 AND state IN ('failed','blocked','send_unknown')
       AND updated_at >= $2 AND updated_at < $3 AND ($4::text IS NULL OR rule_id=$4)
       AND ($5::double precision IS NULL OR (updated_at,id) < ($5,$6::text))
       ORDER BY updated_at DESC,id DESC LIMIT $7`,
      [this.accountId, since, until, ruleId, cursor?.time ?? null, cursor?.id ?? null, limit],
    )
  }
  async rulePerformance(since: number, until: number, ruleId: string | null) {
    if (ruleId) await this.getRule(ruleId)
    return this.rows<Record<string, unknown>>(
      `SELECT r.id AS rule_id, r.definition->>'name' AS current_rule_name, r.revision AS current_rule_revision,
       e.rule_revision AS recorded_rule_revision, count(e.id)::int AS matched_comments,
       count(*) FILTER(WHERE e.state='provider_accepted')::int AS provider_accepted,
       count(*) FILTER(WHERE e.state='failed')::int AS failed,
       count(*) FILTER(WHERE e.state='blocked')::int AS blocked,
       count(*) FILTER(WHERE e.state='send_unknown')::int AS uncertain,
       count(*) FILTER(WHERE e.state IN ('pending','retry','sending'))::int AS waiting,
       count(*) FILTER(WHERE e.state='skipped')::int AS skipped,
       count(*) FILTER(WHERE e.state='canceled')::int AS canceled,
       COALESCE(sum(e.attempts),0)::int AS worker_send_attempts,
       count(*) FILTER(WHERE e.state='provider_accepted')::double precision / NULLIF(count(e.id),0) AS acceptance_rate_per_matched_comment,
       avg(e.updated_at-e.received_at) FILTER(WHERE e.state='provider_accepted') AS average_acceptance_latency_seconds,
       percentile_cont(0.95) WITHIN GROUP(ORDER BY e.updated_at-e.received_at) FILTER(WHERE e.state='provider_accepted') AS p95_acceptance_latency_seconds
       FROM @schema.rules r LEFT JOIN @schema.events e ON e.rule_id=r.id AND e.account_id=r.account_id
        AND e.received_at >= $2 AND e.received_at < $3
       WHERE r.account_id=$1 AND ($4::text IS NULL OR r.id=$4)
       GROUP BY r.id,r.definition,r.revision,e.rule_revision ORDER BY r.id,e.rule_revision LIMIT 2000`,
      [this.accountId, since, until, ruleId],
    )
  }
  async reservePublication(now: number, limit = 100) {
    return this.rows<{ id: string }>(
      `WITH ready AS (
      SELECT id FROM @schema.events WHERE account_id = $1 AND state IN ('pending', 'retry')
        AND next_attempt_at <= $2 AND next_enqueue_at <= $2 AND expires_at > $2
        AND EXISTS (SELECT 1 FROM @schema.account_settings WHERE id = 1 AND paused = FALSE)
      ORDER BY received_at, id LIMIT $3 FOR UPDATE SKIP LOCKED
    ) UPDATE @schema.events SET next_enqueue_at = $2 + 120
      WHERE id IN (SELECT id FROM ready) RETURNING id`,
      [this.accountId, now, limit],
    )
  }
  async publicationSucceeded(id: string, now: number) {
    await this.rows(
      'UPDATE @schema.events SET queued_at = $3 WHERE id = $1 AND account_id = $2',
      [id, this.accountId, now],
    )
  }
  async publicationFailed(id: string, now: number) {
    await this.rows(
      `UPDATE @schema.events SET reason = 'queue_publish_failed', next_enqueue_at = $3 + 60, updated_at = $3
      WHERE id = $1 AND account_id = $2 AND state IN ('pending', 'retry')`,
      [id, this.accountId, now],
    )
  }
  async claim(
    id: string,
    token: string,
    now: number,
  ): Promise<EventRecord | null> {
    const results = await this.batch([
      [
        `UPDATE @schema.events e SET state = 'sending', reason = 'send_claimed', claim_token = $3,
        sending_started_at = $4, attempts = attempts + 1, updated_at = $4, safe_to_retry = FALSE
       WHERE id = $1 AND account_id = $2 AND state IN ('pending','retry') AND next_attempt_at <= $4
         AND expires_at > $4 AND attempts < max_attempts
         AND EXISTS (SELECT 1 FROM @schema.account_settings WHERE id = 1 AND paused = FALSE)
         AND EXISTS (SELECT 1 FROM @schema.rules r WHERE r.id = e.rule_id AND r.enabled = TRUE)
       RETURNING id`,
        [id, this.accountId, token, now],
      ],
      [
        `INSERT INTO @schema.post_contact_gates AS gate (account_id, media_id, commenter_id, owner_event_id, next_allowed_at)
        SELECT account_id, media_id, commenter_id, id, expires_at FROM @schema.events WHERE id = $1 AND claim_token = $2 AND state = 'sending'
        ON CONFLICT (account_id, media_id, commenter_id) DO UPDATE SET owner_event_id = EXCLUDED.owner_event_id, next_allowed_at = EXCLUDED.next_allowed_at
        WHERE gate.next_allowed_at <= $3 OR gate.owner_event_id = EXCLUDED.owner_event_id`,
        [id, token, now],
      ],
      [
        `UPDATE @schema.events e SET state = 'skipped', reason = 'contact_cooldown', updated_at = $3
        WHERE id = $1 AND claim_token = $2 AND state = 'sending' AND NOT EXISTS (
          SELECT 1 FROM @schema.post_contact_gates g WHERE g.account_id = e.account_id AND g.media_id = e.media_id AND g.commenter_id = e.commenter_id AND g.owner_event_id = e.id
        )`,
        [id, token, now],
      ],
      [
        `INSERT INTO @schema.send_attempts (claim_token, event_id, started_at, outcome)
        SELECT claim_token, id, $3, 'sending' FROM @schema.events WHERE id = $1 AND claim_token = $2 AND state = 'sending'`,
        [id, token, now],
      ],
      [
        "SELECT * FROM @schema.events WHERE id = $1 AND claim_token = $2 AND state = 'sending'",
        [id, token],
      ],
    ])
    return (results[4].rows[0] as EventRecord | undefined) ?? null
  }
  async sendEligibility(
    event: EventRecord,
    now: number,
  ): Promise<'ready' | 'paused' | 'disabled' | 'expired' | 'not_claimed'> {
    const rows = await this.rows<{
      eligibility: 'ready' | 'paused' | 'disabled' | 'expired'
    }>(
      `SELECT CASE
        WHEN e.expires_at <= $4 THEN 'expired' WHEN r.enabled IS DISTINCT FROM TRUE THEN 'disabled'
        WHEN (SELECT paused FROM @schema.account_settings WHERE id = 1) THEN 'paused' ELSE 'ready' END AS eligibility
      FROM @schema.events e LEFT JOIN @schema.rules r ON r.id = e.rule_id
      WHERE e.id = $1 AND e.account_id = $2 AND e.claim_token = $3 AND e.state = 'sending'
      `,
      [event.id, this.accountId, event.claim_token, now],
    )
    return rows[0]?.eligibility ?? 'not_claimed'
  }
  async finish(event: EventRecord, outcome: Outcome, now: number) {
    const params = [
      event.id,
      this.accountId,
      event.claim_token,
      outcome.state,
      outcome.reason,
      Boolean(outcome.safeToRetry),
      outcome.nextAttemptAt ?? 0,
      outcome.messageId ?? null,
      outcome.recipientId ?? null,
      outcome.errorCode ?? null,
      outcome.errorSubcode ?? null,
      now,
    ]
    await this.batch([
      [
        `UPDATE @schema.events SET state = $4, reason = $5, safe_to_retry = $6, next_attempt_at = $7,
        next_enqueue_at = $7, provider_message_id = $8, provider_recipient_id = $9, provider_error_code = $10,
        provider_error_subcode = $11, updated_at = $12
        WHERE id = $1 AND account_id = $2 AND claim_token = $3 AND state IN ('sending', 'send_unknown')`,
        params,
      ],
      [
        `INSERT INTO @schema.comment_replies (event_id,account_id,comment_id,reply_text,state,reason,created_at,updated_at)
         SELECT id,account_id,comment_id,public_reply_text,'pending','dm_accepted',$4,$4
         FROM @schema.events WHERE id=$1 AND account_id=$2 AND claim_token=$3
           AND state='provider_accepted' AND provider_message_id IS NOT NULL AND public_reply_text IS NOT NULL
         ON CONFLICT(event_id) DO NOTHING`,
        [event.id,this.accountId,event.claim_token,now],
      ],
      [
        `UPDATE @schema.send_attempts a SET outcome = e.state, finished_at = $2,
        provider_error_code = e.provider_error_code, provider_error_subcode = e.provider_error_subcode
        FROM @schema.events e WHERE a.claim_token = $1 AND e.id = a.event_id AND e.claim_token = a.claim_token`,
        [event.claim_token, now],
      ],
      [
        `UPDATE @schema.post_contact_gates g SET next_allowed_at = $2 + e.cooldown_seconds
        FROM @schema.events e WHERE e.id = $1 AND e.state = 'provider_accepted' AND g.account_id = e.account_id AND g.media_id = e.media_id AND g.owner_event_id = e.id`,
        [event.id, now],
      ],
      [
        `DELETE FROM @schema.post_contact_gates g USING @schema.events e
        WHERE e.id = $1 AND g.account_id = e.account_id AND g.media_id = e.media_id AND g.owner_event_id = e.id AND e.state IN ('failed', 'blocked', 'canceled')`,
        [event.id],
      ],
    ])
  }
  async getPublicReply(eventId: string) {
    await this.getEvent(eventId)
    const [reply] = await this.rows<PublicReplyRecord>(
      `SELECT p.*,e.expires_at FROM @schema.comment_replies p JOIN @schema.events e ON e.id=p.event_id
       WHERE p.event_id=$1 AND p.account_id=$2`, [eventId,this.accountId])
    const attempts = reply ? await this.rows(
      'SELECT * FROM @schema.comment_reply_attempts WHERE event_id=$1 ORDER BY started_at DESC LIMIT 100', [eventId]) : []
    return { reply: reply ?? null, attempts }
  }
  async publicBacklog(now: number) {
    return this.rows<{ state: string; count: number; oldest_received_at: number; oldest_age_seconds: number; oldest_actionable_age_seconds: number; sample_event_id: string }>(
      `SELECT state,count(*)::int AS count,MIN(created_at) AS oldest_received_at,$2-MIN(created_at) AS oldest_age_seconds,
       $2-MIN(CASE WHEN state IN ('pending','retry') THEN GREATEST(created_at,next_attempt_at)
         WHEN state='sending' THEN COALESCE(sending_started_at,updated_at) ELSE updated_at END) AS oldest_actionable_age_seconds,
       MIN(event_id) AS sample_event_id FROM @schema.comment_replies WHERE account_id=$1 GROUP BY state`, [this.accountId,now])
  }
  async reservePublicPublication(now: number, limit=100) {
    return this.rows<{ event_id: string }>(
      `WITH ready AS (
         SELECT p.event_id FROM @schema.comment_replies p JOIN @schema.events e ON e.id=p.event_id
         WHERE p.account_id=$1 AND p.state IN ('pending','retry') AND p.next_attempt_at <= $2 AND p.next_enqueue_at <= $2
           AND p.attempts < p.max_attempts AND e.expires_at > $2 AND e.state='provider_accepted'
           AND EXISTS(SELECT 1 FROM @schema.account_settings WHERE id=1 AND paused=FALSE)
           AND EXISTS(SELECT 1 FROM @schema.rules r WHERE r.id=e.rule_id AND r.enabled=TRUE)
         ORDER BY p.created_at,p.event_id LIMIT $3 FOR UPDATE OF p SKIP LOCKED
       ) UPDATE @schema.comment_replies SET next_enqueue_at=$2+120 WHERE event_id IN (SELECT event_id FROM ready) RETURNING event_id`,
      [this.accountId,now,limit])
  }
  async publicPublicationSucceeded(eventId: string, now: number) {
    await this.rows('UPDATE @schema.comment_replies SET queued_at=$3 WHERE event_id=$1 AND account_id=$2', [eventId,this.accountId,now])
  }
  async publicPublicationFailed(eventId: string, now: number) {
    await this.rows(`UPDATE @schema.comment_replies SET reason='queue_publish_failed',next_enqueue_at=$3+60,updated_at=$3
      WHERE event_id=$1 AND account_id=$2 AND state IN ('pending','retry')`, [eventId,this.accountId,now])
  }
  async claimPublicReply(eventId: string, token: string, now: number): Promise<PublicReplyRecord | null> {
    const results = await this.batch([
      [`UPDATE @schema.comment_replies p SET state='sending',reason='public_reply_claimed',claim_token=$3,
         sending_started_at=$4,attempts=p.attempts+1,updated_at=$4
       FROM @schema.events e WHERE p.event_id=$1 AND p.account_id=$2 AND e.id=p.event_id
         AND p.state IN ('pending','retry') AND p.next_attempt_at <= $4 AND p.attempts < p.max_attempts
         AND e.state='provider_accepted' AND e.provider_message_id IS NOT NULL AND e.expires_at > $4
         AND EXISTS(SELECT 1 FROM @schema.account_settings WHERE id=1 AND paused=FALSE)
         AND EXISTS(SELECT 1 FROM @schema.rules r WHERE r.id=e.rule_id AND r.enabled=TRUE)
       RETURNING p.event_id`, [eventId,this.accountId,token,now]],
      [`INSERT INTO @schema.comment_reply_attempts(claim_token,event_id,started_at,outcome)
        SELECT claim_token,event_id,$3,'sending' FROM @schema.comment_replies WHERE event_id=$1 AND claim_token=$2 AND state='sending'`, [eventId,token,now]],
      [`SELECT p.*,e.expires_at FROM @schema.comment_replies p JOIN @schema.events e ON e.id=p.event_id
        WHERE p.event_id=$1 AND p.claim_token=$2 AND p.state='sending'`, [eventId,token]],
    ])
    return (results[2].rows[0] as PublicReplyRecord | undefined) ?? null
  }
  async publicSendEligibility(reply: PublicReplyRecord, now: number): Promise<'ready'|'paused'|'disabled'|'expired'|'dm_not_accepted'|'not_claimed'> {
    const rows = await this.rows<{ eligibility: 'ready'|'paused'|'disabled'|'expired'|'dm_not_accepted' }>(
      `SELECT CASE WHEN e.state <> 'provider_accepted' OR e.provider_message_id IS NULL THEN 'dm_not_accepted'
         WHEN e.expires_at <= $4 THEN 'expired' WHEN r.enabled IS DISTINCT FROM TRUE THEN 'disabled'
         WHEN (SELECT paused FROM @schema.account_settings WHERE id=1) THEN 'paused' ELSE 'ready' END AS eligibility
       FROM @schema.comment_replies p JOIN @schema.events e ON e.id=p.event_id LEFT JOIN @schema.rules r ON r.id=e.rule_id
       WHERE p.event_id=$1 AND p.account_id=$2 AND p.claim_token=$3 AND p.state='sending'`,
      [reply.event_id,this.accountId,reply.claim_token,now])
    return rows[0]?.eligibility ?? 'not_claimed'
  }
  async finishPublicReply(reply: PublicReplyRecord, outcome: Outcome, now: number) {
    await this.batch([
      [`UPDATE @schema.comment_replies SET state=$4,reason=$5,next_attempt_at=$6,next_enqueue_at=$6,
         provider_reply_id=$7,provider_error_code=$8,provider_error_subcode=$9,updated_at=$10
       WHERE event_id=$1 AND account_id=$2 AND claim_token=$3 AND state IN ('sending','send_unknown')`,
       [reply.event_id,this.accountId,reply.claim_token,outcome.state,outcome.reason,outcome.nextAttemptAt ?? 0,
        outcome.messageId ?? null,outcome.errorCode ?? null,outcome.errorSubcode ?? null,now]],
      [`UPDATE @schema.comment_reply_attempts a SET outcome=p.state,finished_at=$2,
         provider_error_code=p.provider_error_code,provider_error_subcode=p.provider_error_subcode
       FROM @schema.comment_replies p WHERE a.claim_token=$1 AND p.event_id=a.event_id AND p.claim_token=a.claim_token`, [reply.claim_token,now]],
    ])
  }
  async deadLetterPublic(eventId: string, now: number) {
    await this.rows(`UPDATE @schema.comment_replies SET state='failed',reason='queue_retries_exhausted',updated_at=$3
      WHERE event_id=$1 AND account_id=$2 AND state IN ('pending','retry')`, [eventId,this.accountId,now])
  }
  async retryEvent(id: string, actor: string, now: number) {
    const [event] = await this.rows<EventRecord>(
      `WITH changed AS (UPDATE @schema.events e SET state = 'retry', reason = $4,
      next_attempt_at = $3, next_enqueue_at = $3, max_attempts = attempts + 5, updated_at = $3
      WHERE id = $1 AND account_id = $2 AND state IN ('failed', 'blocked') AND safe_to_retry = TRUE
        AND expires_at > $3 AND EXISTS (SELECT 1 FROM @schema.rules r WHERE r.id = e.rule_id AND r.enabled = TRUE)
      RETURNING *), audit AS (
        INSERT INTO @schema.event_operations (event_id, operation, actor, changed_at)
        SELECT id, 'retry', $5, $3 FROM changed
      ) SELECT * FROM changed`,
      [id, this.accountId, now, `manual_retry:${actor}`, actor],
    )
    if (!event)
      throw new PublicError(
        'Only a safely rejected failed/blocked event with an enabled rule and an unexpired comment can be retried. Accepted or uncertain sends cannot be retried.',
      )
    return event
  }
  async eventOperations(id: string) {
    await this.getEvent(id)
    return this.rows(
      'SELECT operation, actor, changed_at FROM @schema.event_operations WHERE event_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 100',
      [id],
    )
  }
  async deadLetter(id: string, now: number) {
    await this.rows(
      `UPDATE @schema.events SET state = 'failed', reason = 'queue_retries_exhausted', safe_to_retry = TRUE, updated_at = $3
      WHERE id = $1 AND account_id = $2 AND state IN ('pending','retry')`,
      [id, this.accountId, now],
    )
  }
  async recover(now: number, retentionDays: number) {
    await this.batch([
      [`UPDATE @schema.comment_replies SET state='send_unknown',reason='public_reply_worker_interrupted',updated_at=$2
        WHERE account_id=$1 AND state='sending' AND sending_started_at < $2-90`, [this.accountId,now]],
      [`UPDATE @schema.comment_reply_attempts a SET outcome='send_unknown',finished_at=$2 FROM @schema.comment_replies p
        WHERE p.account_id=$1 AND p.state='send_unknown' AND p.event_id=a.event_id AND a.claim_token=p.claim_token AND a.outcome='sending'`, [this.accountId,now]],
      [`UPDATE @schema.comment_replies p SET state='canceled',reason=CASE WHEN e.expires_at <= $2 THEN 'comment_expired' ELSE 'rule_disabled' END,updated_at=$2
        FROM @schema.events e WHERE p.account_id=$1 AND p.event_id=e.id AND p.state IN ('pending','retry')
          AND (e.expires_at <= $2 OR NOT EXISTS(SELECT 1 FROM @schema.rules r WHERE r.id=e.rule_id AND r.enabled=TRUE))`, [this.accountId,now]],
      [`UPDATE @schema.comment_replies SET state='failed',reason='send_retries_exhausted',updated_at=$2
        WHERE account_id=$1 AND state IN ('pending','retry') AND attempts >= max_attempts`, [this.accountId,now]],
      [
        `UPDATE @schema.events SET state = 'send_unknown', reason = 'send_worker_interrupted', safe_to_retry = FALSE, updated_at = $2
        WHERE account_id = $1 AND state = 'sending' AND sending_started_at < $2 - 90`,
        [this.accountId, now],
      ],
      [
        `UPDATE @schema.send_attempts a SET outcome = 'send_unknown', finished_at = $2 FROM @schema.events e
        WHERE e.account_id = $1 AND e.state = 'send_unknown' AND e.id = a.event_id AND a.claim_token = e.claim_token AND a.outcome = 'sending'`,
        [this.accountId, now],
      ],
      [
        `UPDATE @schema.events e SET state = 'canceled', reason = CASE WHEN expires_at <= $2 THEN 'comment_expired' ELSE 'rule_disabled' END, updated_at = $2
        WHERE account_id = $1 AND state IN ('pending','retry') AND (expires_at <= $2 OR NOT EXISTS (SELECT 1 FROM @schema.rules r WHERE r.id = e.rule_id AND r.enabled = TRUE))`,
        [this.accountId, now],
      ],
      [
        `UPDATE @schema.events SET state = 'failed', reason = 'send_retries_exhausted', safe_to_retry = TRUE, updated_at = $2
        WHERE account_id = $1 AND state IN ('pending','retry') AND attempts >= max_attempts`,
        [this.accountId, now],
      ],
      [
        'DELETE FROM @schema.post_contact_gates WHERE account_id = $1 AND next_allowed_at < $2',
        [this.accountId, now],
      ],
      [
        'DELETE FROM @schema.contact_gates WHERE account_id = $1 AND next_allowed_at < $2',
        [this.accountId, now],
      ],
      [
        `DELETE FROM @schema.events e WHERE account_id = $1 AND received_at < $2 AND state NOT IN ('pending','retry','sending')
          AND NOT EXISTS(SELECT 1 FROM @schema.comment_replies p WHERE p.event_id=e.id AND p.state IN ('pending','retry','sending'))`,
        [this.accountId, now - retentionDays * 86400],
      ],
      [
        'UPDATE @schema.account_settings SET last_recovery_at = $1 WHERE id = 1',
        [now],
      ],
    ])
  }
}
