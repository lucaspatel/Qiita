-- migrate:up

-- A profiling database: a prebuilt, opaque file a profiler reads whole (today a
-- sylph `.syl2db` / `.syldb`), registered where an operator staged it rather than
-- ingested through reference-add. It carries no sequences, so no feature or
-- genome rows: the reference row names it and versions it, and its one
-- reference_index row (index_type 'sylph') records the file's path, format,
-- sha256 and size. Mirrors qiita_common.models.ReferenceKind and
-- INDEX_TYPE_SYLPH. Both columns are plain TEXT + CHECK (not Postgres ENUMs), so
-- these are CHECK widens with no ENUM_PAIRS entry.
ALTER TABLE qiita.reference
    DROP CONSTRAINT reference_kind_check;
ALTER TABLE qiita.reference
    ADD CONSTRAINT reference_kind_check
    CHECK (kind IN ('sequence_reference', 'taxonomy_authority', 'artifact_sequence_set',
                    'profiling_database'));

ALTER TABLE qiita.reference_index
    DROP CONSTRAINT IF EXISTS reference_index_index_type_check;
ALTER TABLE qiita.reference_index
    ADD CONSTRAINT reference_index_index_type_check
    CHECK (index_type IN ('rype', 'minimap2', 'bowtie2', 'rype_router', 'sylph'));

-- migrate:down

-- Fails loudly while any profiling_database reference or sylph index row
-- exists, which is correct: don't silently strand one.
ALTER TABLE qiita.reference_index
    DROP CONSTRAINT IF EXISTS reference_index_index_type_check;
ALTER TABLE qiita.reference_index
    ADD CONSTRAINT reference_index_index_type_check
    CHECK (index_type IN ('rype', 'minimap2', 'bowtie2', 'rype_router'));

ALTER TABLE qiita.reference
    DROP CONSTRAINT reference_kind_check;
ALTER TABLE qiita.reference
    ADD CONSTRAINT reference_kind_check
    CHECK (kind IN ('sequence_reference', 'taxonomy_authority', 'artifact_sequence_set'));
