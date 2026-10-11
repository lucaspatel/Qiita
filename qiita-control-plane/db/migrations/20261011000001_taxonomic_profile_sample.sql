-- migrate:up
-- =============================================================================
-- TAXONOMIC PROFILE SAMPLE (per-(processing, sample) completion gate)
-- =============================================================================
-- The completion gate for taxonomic profiling, the twin of qiita.amplicon_sample.
-- The profile rows live in DuckLake `taxonomic_profile`, which a Postgres
-- consumer — the study lineage — cannot read cheaply, and which cannot say "this
-- sample was profiled and matched nothing".
--
-- Keyed on the RUN identity (qiita.processing): processing_idx hashes the
-- profiler, its version, the profiling database (reference_idx and the file's
-- sha256) and the result-affecting thresholds, so profiling one sample with a
-- different method or database is a different row, and a different branch of the
-- lineage.
--
-- A profiling ticket covers a sequenced pool, but only its metagenomic samples:
--
--   'pending'   materialized by the runner for the pool's metagenomic samples
--               when it mints the run's processing_idx, before the step loop.
--   'completed' written by the terminal `finalize-taxonomic-profile-sample`
--               action for each sample the profiler reported genomes for, with
--               how many.
--   'no_data'   written by the same action for each of the run's pending samples
--               it reported nothing for.
--
-- A failed ticket leaves its rows 'pending'; a re-run under the same params
-- resolves to the same processing_idx and closes them.
--
-- `state` is TEXT + CHECK, not an ENUM: the gate has no wire surface of its own,
-- as for qiita.amplicon_sample.
CREATE TABLE qiita.taxonomic_profile_sample (
    -- RESTRICT: one processing row is shared by every pool profiled under the
    -- same params.
    processing_idx   BIGINT NOT NULL
        REFERENCES qiita.processing(processing_idx) ON DELETE RESTRICT,
    prep_sample_idx  BIGINT NOT NULL REFERENCES qiita.prep_sample(idx) ON DELETE RESTRICT,
    state            TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'completed', 'no_data')),
    -- How many genomes the profiler reported in this sample; set with 'completed' only.
    genome_count     INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (processing_idx, prep_sample_idx),
    CONSTRAINT taxonomic_profile_sample_genome_count_with_completed CHECK (
        (state = 'completed') = (genome_count IS NOT NULL)
    ),
    CONSTRAINT taxonomic_profile_sample_genome_count_positive CHECK (
        genome_count IS NULL OR genome_count > 0
    )
);

COMMENT ON TABLE qiita.taxonomic_profile_sample IS
    'Per-(processing_idx, prep_sample) completion gate for taxonomic profiling. '
    'Materialized ''pending'' for the pool''s metagenomic samples when the runner '
    'mints the run identity, then written ''completed'' (with genome_count) or '
    '''no_data'' by the terminal finalize-taxonomic-profile-sample action. Twin of '
    'qiita.amplicon_sample.';

-- The lineage reads by prep_sample; the PRIMARY KEY leads with processing_idx.
CREATE INDEX taxonomic_profile_sample_prep_sample_idx
    ON qiita.taxonomic_profile_sample (prep_sample_idx);

CREATE TRIGGER taxonomic_profile_sample_set_updated_at
    BEFORE UPDATE ON qiita.taxonomic_profile_sample
    FOR EACH ROW EXECUTE FUNCTION qiita.set_updated_at();

-- migrate:down
DROP TABLE IF EXISTS qiita.taxonomic_profile_sample;
