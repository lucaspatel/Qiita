"""Principal coordinates and PERMANOVA of a feature table, in the browser, with
scikit-bio itself (built for Pyodide; see static/wheels/).

The table arrives as sparse COO and is made dense here, in the worker, only for
the samples placed. Depth is evened out one of two ways, so sequencing depth
alone does not separate samples: rarefying every sample to one depth
(`skbio.stats.subsample_counts`, seeded per sample so the same sample at the same
depth always gives the same answer; samples below it are dropped), or, with no
depth, comparing relative abundance.

The return shapes are what the page reads; they do not depend on the engine.
"""

import hashlib

import numpy as np
from skbio import DistanceMatrix
from skbio.diversity import beta_diversity
from skbio.stats import subsample_counts
from skbio.stats.distance import permanova as skbio_permanova
from skbio.stats.ordination import pcoa

RAREFACTION_SEED = 0
PERMANOVA_SEED = 0

# The last PCoA's distance matrix, so a PERMANOVA over a new grouping needs no
# recompute.
_last: dict = {}


def _sample_seed(name: str) -> list[int]:
    """One random stream per sample, keyed by its name: a sample's subsample then
    depends on nothing else in the table, so adding samples or merging runs leaves
    every other sample's rarefied counts unchanged."""
    return [RAREFACTION_SEED, int.from_bytes(hashlib.md5(name.encode()).digest()[:8])]


def pcoa_coo(
    samples: list,
    n_features: int,
    sample_codes,
    feature_codes,
    values,
    depth: int | None = None,
    dimensions: int = 3,
) -> dict:
    """The table's samples on their leading principal coordinates (Bray-Curtis).

    Observation i is (`sample_codes[i]`, `feature_codes[i]`, `values[i]`), codes
    into `samples` and a feature space of `n_features`. Returns the samples placed,
    one coordinate list per axis, each axis's proportion explained, every sample's
    total count (`depths`, the whole table's), and the samples a depth dropped.
    """
    names = [str(s) for s in samples]
    counts = np.zeros((len(names), int(n_features)), dtype=np.int64)
    np.add.at(
        counts,
        (
            np.asarray(sample_codes, dtype=np.int64),
            np.asarray(feature_codes, dtype=np.int64),
        ),
        np.asarray(values, dtype=np.int64),
    )
    totals = counts.sum(axis=1)
    if (totals <= 0).any():
        empty = [n for n, d in zip(names, totals) if d <= 0]
        raise ValueError(f"{len(empty)} sample(s) have no counts, e.g. {empty[:3]}")

    dropped: list[str] = []
    if depth is None:
        profiles = counts / totals[:, None]
    else:
        if depth <= 0:
            raise ValueError(f"rarefaction depth must be positive, not {depth}")
        keep = totals >= depth
        dropped = [n for n, k in zip(names, keep) if not k]
        names = [n for n, k in zip(names, keep) if k]
        profiles = np.array(
            [
                subsample_counts(
                    row, depth, seed=np.random.default_rng(_sample_seed(name))
                )
                for name, row in zip(names, counts[keep], strict=True)
            ]
        )
    if len(names) < 3:
        raise ValueError(
            f"a PCoA needs at least three samples; {len(names)} reach that depth"
        )

    dm = beta_diversity("braycurtis", profiles, ids=names, validate=depth is not None)
    _last["dm"] = dm
    result = pcoa(dm, method="eigh", dimensions=dimensions, warn_neg_eigval=False)
    k = result.samples.shape[1]
    return {
        "samples": names,
        "axes": [result.samples.iloc[:, i].tolist() for i in range(k)],
        "proportion_explained": result.proportion_explained.iloc[:k].tolist(),
        "n_features": int(counts.shape[1]),
        "n_samples": len(names),
        "depth": depth,
        "depths": [int(t) for t in totals],
        "dropped": dropped,
    }


def permanova(groups: dict, permutations: int = 999) -> dict:
    """PERMANOVA of the last PCoA's distances by `groups` (sample name -> value),
    with `skbio.stats.distance.permanova`. Samples without a value (None, or
    absent) are left out and counted; a grouping with one group, or one group per
    sample, has no test and comes back `skipped`."""
    if "dm" not in _last:
        raise ValueError("no PCoA has been computed")
    dm: DistanceMatrix = _last["dm"]
    ids = [i for i in dm.ids if groups.get(i) is not None]
    labels = [str(groups[i]) for i in ids]
    n_groups = len(set(labels))
    base = {
        "method": "PERMANOVA",
        "test_statistic_name": "pseudo-F",
        "sample_size": len(ids),
        "number_of_groups": n_groups,
        "excluded": len(dm.ids) - len(ids),
        "permutations": permutations,
    }
    if n_groups < 2:
        return {**base, "skipped": "every sample is in one group"}
    if n_groups == len(ids):
        return {**base, "skipped": "every sample is in its own group"}
    r = skbio_permanova(
        dm.filter(ids), labels, permutations=permutations, seed=PERMANOVA_SEED
    )
    return {
        **base,
        "test_statistic": float(r["test statistic"]),
        "p_value": float(r["p-value"]),
    }
