def test_the_dummy_sheet_placeholder_index_is_never_decodable():
    """bcl-convert assigns a read to the dummy sheet's placeholder sample only when
    its index read is exactly AMPLICON_PLACEHOLDER_INDEX. The demux decodes the
    index's reverse complement, so that must sit beyond the correctable radius of
    every codeword: then the placeholder can only ever hold reads the demux drops."""
    from qiita_common.illumina import AMPLICON_PLACEHOLDER_INDEX

    from qiita_compute_orchestrator.jobs.golay_demux import (
        _BITS_TO_NT,
        _MAX_CORRECTABLE,
        _golay_codeword,
    )

    complement = str.maketrans("ACGT", "TGCA")
    decoded_form = AMPLICON_PLACEHOLDER_INDEX[::-1].translate(complement)
    word = 0
    for nt in decoded_form:
        word = (word << 2) | _BITS_TO_NT.index(nt)
    nearest = min(bin(word ^ _golay_codeword(m)).count("1") for m in range(4096))
    assert nearest > _MAX_CORRECTABLE
