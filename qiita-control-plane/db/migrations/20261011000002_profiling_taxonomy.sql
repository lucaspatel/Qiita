-- migrate:up

-- A profiling database ships more than its index: a sylph release comes with a
-- taxonomy file naming each genome's lineage (GTDB-style `d__...;s__...`). It is
-- registered on the same `profiling_database` reference as one more index row,
-- index_type 'sylph_taxonomy' (its path, sha256, size and genome count), and its
-- rows are loaded here so a feature table can label a profiled genome with its
-- lineage without re-reading the file. Mirrors INDEX_TYPE_SYLPH_TAXONOMY.
ALTER TABLE qiita.reference_index
    DROP CONSTRAINT IF EXISTS reference_index_index_type_check;
ALTER TABLE qiita.reference_index
    ADD CONSTRAINT reference_index_index_type_check
    CHECK (index_type IN ('rype', 'minimap2', 'bowtie2', 'rype_router', 'sylph',
                          'sylph_taxonomy'));

-- One row per genome of a profiling database: `genome` is the genome's file name
-- as the database names it (its basename, e.g. `G000802255.fna.gz`), the key a
-- profile's genome_name reduces to; `lineage` is the taxonomy file's string as
-- given. Registering a taxonomy file replaces the reference's rows.
CREATE TABLE qiita.profiling_taxonomy (
    reference_idx  BIGINT NOT NULL REFERENCES qiita.reference(reference_idx) ON DELETE RESTRICT,
    genome         TEXT NOT NULL CHECK (genome <> ''),
    lineage        TEXT NOT NULL,
    PRIMARY KEY (reference_idx, genome)
);

COMMENT ON TABLE qiita.profiling_taxonomy IS
    'Each genome''s lineage for a profiling_database reference, loaded from its '
    'registered sylph_taxonomy file; keyed by the genome''s file basename.';

-- migrate:down
DROP TABLE IF EXISTS qiita.profiling_taxonomy;

-- Fails loudly while a sylph_taxonomy row exists, which is correct.
ALTER TABLE qiita.reference_index
    DROP CONSTRAINT IF EXISTS reference_index_index_type_check;
ALTER TABLE qiita.reference_index
    ADD CONSTRAINT reference_index_index_type_check
    CHECK (index_type IN ('rype', 'minimap2', 'bowtie2', 'rype_router', 'sylph'));
