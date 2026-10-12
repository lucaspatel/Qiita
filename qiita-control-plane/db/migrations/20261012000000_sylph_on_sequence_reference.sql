-- migrate:up

-- A sylph database is sketched from a sequence reference's genomes, so it is
-- registered as one more index row of that reference (index_type 'sylph', beside
-- its aligner indexes), and a profile reports those genomes by their
-- qiita.genome rows. That replaces the standalone `profiling_database` reference
-- and its own taxonomy store: a genome's lineage is the reference's
-- `reference_taxonomy`, as it is for an alignment.
--
-- Releases that never saw the standalone form have nothing to clear here. One
-- that did loses its profiling_database references and the profile runs read
-- against them: their lake rows name genomes by file path, which no feature table
-- can label any more, so their gate rows go and they leave the lineage.
DELETE FROM qiita.taxonomic_profile_sample
 WHERE processing_idx IN (
    SELECT p.processing_idx
      FROM qiita.processing p
      JOIN qiita.reference r
        ON r.reference_idx = (p.params ->> 'sylph_reference_idx')::BIGINT
     WHERE r.kind = 'profiling_database');

DROP TABLE qiita.profiling_taxonomy;

DELETE FROM qiita.reference_index
 WHERE index_type = 'sylph_taxonomy'
    OR reference_idx IN (
        SELECT reference_idx FROM qiita.reference WHERE kind = 'profiling_database');
DELETE FROM qiita.reference WHERE kind = 'profiling_database';

-- Mirrors INDEX_TYPE_SYLPH and qiita_common.models.ReferenceKind.
ALTER TABLE qiita.reference_index
    DROP CONSTRAINT IF EXISTS reference_index_index_type_check;
ALTER TABLE qiita.reference_index
    ADD CONSTRAINT reference_index_index_type_check
    CHECK (index_type IN ('rype', 'minimap2', 'bowtie2', 'rype_router', 'sylph'));

ALTER TABLE qiita.reference
    DROP CONSTRAINT reference_kind_check;
ALTER TABLE qiita.reference
    ADD CONSTRAINT reference_kind_check
    CHECK (kind IN ('sequence_reference', 'taxonomy_authority', 'artifact_sequence_set'));

-- migrate:down

-- Restores the shapes, not the rows deleted above.
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
    CHECK (index_type IN ('rype', 'minimap2', 'bowtie2', 'rype_router', 'sylph',
                          'sylph_taxonomy'));

CREATE TABLE qiita.profiling_taxonomy (
    reference_idx  BIGINT NOT NULL REFERENCES qiita.reference(reference_idx) ON DELETE RESTRICT,
    genome         TEXT NOT NULL CHECK (genome <> ''),
    lineage        TEXT NOT NULL,
    PRIMARY KEY (reference_idx, genome)
);
