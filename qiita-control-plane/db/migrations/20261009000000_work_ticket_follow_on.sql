-- migrate:up

-- A follow-on ticket: work the control plane submits on the originator's behalf
-- once this ticket COMPLETES, on the same scope target. It is what lets one
-- gesture run a chain whose second half needs the first half's output to exist
-- (golay-demux stores a pool's reads; amplicon denoises them).
--
-- `on_success` is the follow-on's {action_id, action_version, action_context}.
-- It is gated at submission exactly as if it were submitted then (action,
-- audience, scopes, target kind, context schema, ingest paths), so a refusal at
-- completion time can only come from state that changed in between.
--
-- The outcome is recorded here, never silently dropped:
--   follow_on_claimed_at       set once, by the one process that submits it
--   follow_on_work_ticket_idx  the ticket that submission created
--   follow_on_error            why it was not created (the refusal's detail)
ALTER TABLE qiita.work_ticket
    ADD COLUMN on_success JSONB,
    ADD COLUMN follow_on_claimed_at TIMESTAMPTZ,
    ADD COLUMN follow_on_work_ticket_idx BIGINT
        REFERENCES qiita.work_ticket(work_ticket_idx) ON DELETE SET NULL,
    ADD COLUMN follow_on_error TEXT;

ALTER TABLE qiita.work_ticket
    ADD CONSTRAINT work_ticket_follow_on_needs_on_success CHECK (
        on_success IS NOT NULL
        OR (follow_on_claimed_at IS NULL
            AND follow_on_work_ticket_idx IS NULL
            AND follow_on_error IS NULL)
    ),
    ADD CONSTRAINT work_ticket_follow_on_one_outcome CHECK (
        num_nonnulls(follow_on_work_ticket_idx, follow_on_error) <= 1
    );

COMMENT ON COLUMN qiita.work_ticket.on_success IS
    'Follow-on {action_id, action_version, action_context} submitted by the control '
    'plane as the originator, on this ticket''s scope target, once it COMPLETES. '
    'NULL = no follow-on.';
COMMENT ON COLUMN qiita.work_ticket.follow_on_claimed_at IS
    'When the control plane claimed the follow-on submission. Set by one '
    'conditional UPDATE so the follow-on is submitted at most once.';
COMMENT ON COLUMN qiita.work_ticket.follow_on_work_ticket_idx IS
    'The ticket the follow-on submission created.';
COMMENT ON COLUMN qiita.work_ticket.follow_on_error IS
    'Why the follow-on submission was refused or failed; NULL on success.';

-- The startup reconcile scans for completed tickets whose follow-on has no
-- outcome yet; keep that scan off the full table.
CREATE INDEX work_ticket_follow_on_pending_idx
    ON qiita.work_ticket (work_ticket_idx)
    WHERE on_success IS NOT NULL
      AND follow_on_work_ticket_idx IS NULL
      AND follow_on_error IS NULL;

-- migrate:down

DROP INDEX IF EXISTS qiita.work_ticket_follow_on_pending_idx;
ALTER TABLE qiita.work_ticket
    DROP CONSTRAINT IF EXISTS work_ticket_follow_on_one_outcome,
    DROP CONSTRAINT IF EXISTS work_ticket_follow_on_needs_on_success,
    DROP COLUMN IF EXISTS follow_on_error,
    DROP COLUMN IF EXISTS follow_on_work_ticket_idx,
    DROP COLUMN IF EXISTS follow_on_claimed_at,
    DROP COLUMN IF EXISTS on_success;
