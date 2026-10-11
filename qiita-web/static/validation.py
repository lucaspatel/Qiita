"""
METAMEQ validation runner for Pyodide environment.
Direct API calls — skips file I/O round-trip used by write_validator_metadata.
"""

import sys
import io
import traceback
import pandas as pd
from metameq import (
    extract_config_dict,
    get_qc_failures,
    SAMPLE_NAME_KEY,
    QC_NOTE_KEY,
    HOSTTYPE_SHORTHAND_KEY,
    SAMPLETYPE_SHORTHAND_KEY,
)
from metameq.src.metadata_extender import _extend_metadata_from_full_flat_config

# Monkey-patch: metameq 2026.2.6 format_validation_msgs_as_df crashes on
# cerberus anyof errors because they produce nested dict error messages that
# pandas can't sort. Patch converts all error messages to strings first.
# Must patch in both modules since metadata_extender imports it directly.
import metameq.src.metadata_validator as _mv
import metameq.src.metadata_extender as _me

if not hasattr(_mv, "_orig_format_validation_msgs_as_df"):
    _mv._orig_format_validation_msgs_as_df = _mv.format_validation_msgs_as_df

    def _safe_format_validation_msgs_as_df(validation_msgs):
        for msg in validation_msgs:
            msg["error_message"] = [
                str(e) if not isinstance(e, str) else e for e in msg["error_message"]
            ]
        return _mv._orig_format_validation_msgs_as_df(validation_msgs)

    _mv.format_validation_msgs_as_df = _safe_format_validation_msgs_as_df
    _me.format_validation_msgs_as_df = _safe_format_validation_msgs_as_df


# Map QC note strings to the internal column key they relate to
_QC_NOTE_TO_INTERNAL_KEY = {
    "invalid host_type": HOSTTYPE_SHORTHAND_KEY,
    "invalid sample_type": SAMPLETYPE_SHORTHAND_KEY,
}


def run_metameq_validation(data_path: str, config_path: str, file_ext: str):
    """
    Run METAMEQ validation on the provided data file.

    Direct API approach — no temp-file round-trip:
    1. Load metadata with pd.read_csv / pd.read_excel
    2. Capture original columns before extension
    3. Load config via extract_config_dict (public API)
    4. Extend metadata via _extend_metadata_from_full_flat_config
    5. Convert QC failures to validation messages
    6. Combine cerberus errors + QC messages, sort
    7. Drop internal columns, return result with originalColumns
    """
    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = io.StringIO(), io.StringIO()

    result = {
        "success": False,
        "processed": False,
        "errors": [],
        "extendedMetadata": None,
        "validationErrors": None,
        "originalColumns": None,
        "stdout": "",
        "stderr": "",
        "summary": {"totalRows": 0, "validRows": 0, "errorCount": 0},
    }

    try:
        # 1. Load metadata — read headers from raw file to preserve blanks
        #    (pandas renames empty headers to "Unnamed: X")
        if file_ext in (".xlsx",):
            raw_df = pd.read_excel(data_path, dtype=str)
        else:
            sep = "," if file_ext == ".csv" else "\t"
            raw_df = pd.read_csv(data_path, sep=sep, dtype=str, header=0)
            with open(data_path, "r") as f:
                real_headers = f.readline().rstrip("\r\n").split(sep)
            if len(real_headers) == len(raw_df.columns):
                raw_df.columns = real_headers

        # 2. Capture original columns before metameq extension
        original_columns = list(raw_df.columns)

        # 3. Load config
        config = extract_config_dict(config_path)

        # 4. Extend metadata
        metadata_df, validation_msgs_df, col_name_mapping = (
            _extend_metadata_from_full_flat_config(raw_df, config, None, None, None)
        )

        result["processed"] = True

        # 5. Convert QC failures to validation message records
        qc_failures_df = get_qc_failures(metadata_df)
        qc_records = []
        for _, row in qc_failures_df.iterrows():
            qc_note = row[QC_NOTE_KEY]
            internal_key = _QC_NOTE_TO_INTERNAL_KEY.get(qc_note)
            if internal_key is not None:
                field_name = col_name_mapping.get(internal_key, internal_key)
                field_value = row[internal_key]
            else:
                field_name = qc_note
                field_value = None
            qc_records.append(
                {
                    SAMPLE_NAME_KEY: row[SAMPLE_NAME_KEY],
                    "field_name": field_name,
                    "field_value": field_value,
                    "error_message": qc_note,
                }
            )

        qc_msgs_df = pd.DataFrame(
            qc_records,
            columns=[SAMPLE_NAME_KEY, "field_name", "field_value", "error_message"],
        )

        # 6. Combine cerberus errors + QC messages, sort
        combined_df = pd.concat([validation_msgs_df, qc_msgs_df], ignore_index=True)
        combined_df.sort_values(
            by=[SAMPLE_NAME_KEY, "field_name", "error_message"], inplace=True
        )
        combined_df.reset_index(drop=True, inplace=True)

        # 7. Drop internal columns from metadata
        internal_cols = [HOSTTYPE_SHORTHAND_KEY, SAMPLETYPE_SHORTHAND_KEY, QC_NOTE_KEY]
        metadata_df = metadata_df.drop(columns=internal_cols)

        # Convert to result dicts
        metadata_df = metadata_df.where(metadata_df.notna(), None)
        result["extendedMetadata"] = metadata_df.astype(object).to_dict(
            orient="records"
        )
        result["originalColumns"] = original_columns

        if len(combined_df) > 0:
            combined_df = combined_df.where(combined_df.notna(), None)
            result["validationErrors"] = combined_df.astype(object).to_dict(
                orient="records"
            )

        # Derive summary — count unique failing samples, not individual errors
        total = len(result["extendedMetadata"])
        error_count = (
            len(result["validationErrors"]) if result["validationErrors"] else 0
        )

        if result["validationErrors"]:
            failing_samples = set(
                r[SAMPLE_NAME_KEY]
                for r in result["validationErrors"]
                if r.get(SAMPLE_NAME_KEY) is not None
            )
            valid_rows = total - len(failing_samples)
        else:
            valid_rows = total

        result["summary"]["totalRows"] = total
        result["summary"]["validRows"] = valid_rows
        result["summary"]["errorCount"] = error_count
        result["success"] = error_count == 0

    except Exception as e:
        tb = traceback.format_exc()
        result["errors"].append(
            {"message": f"{str(e)}\n\nTraceback:\n{tb}", "severity": "error"}
        )

    finally:
        result["stdout"] = sys.stdout.getvalue()
        result["stderr"] = sys.stderr.getvalue()
        sys.stdout, sys.stderr = old_stdout, old_stderr

    return result
