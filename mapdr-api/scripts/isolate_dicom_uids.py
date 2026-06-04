#!/usr/bin/env python3
import argparse

import pydicom
from pydicom.uid import generate_uid


def mapped_uid(namespace: str, kind: str, value: str) -> str:
    source = str(value or "").strip()
    if not source:
        source = "missing"
    return generate_uid(entropy_srcs=[namespace, kind, source])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--namespace", required=True)
    args = parser.parse_args()

    namespace = str(args.namespace or "").strip()
    if not namespace:
        raise ValueError("namespace is required")

    ds = pydicom.dcmread(args.input, force=True)

    ds.StudyInstanceUID = mapped_uid(namespace, "StudyInstanceUID", "case")

    if getattr(ds, "SeriesInstanceUID", None):
        ds.SeriesInstanceUID = mapped_uid(namespace, "SeriesInstanceUID", ds.SeriesInstanceUID)
    else:
        ds.SeriesInstanceUID = mapped_uid(namespace, "SeriesInstanceUID", "missing")

    if getattr(ds, "SOPInstanceUID", None):
        ds.SOPInstanceUID = mapped_uid(namespace, "SOPInstanceUID", ds.SOPInstanceUID)
    else:
        ds.SOPInstanceUID = mapped_uid(namespace, "SOPInstanceUID", "missing")

    if getattr(ds, "file_meta", None) is not None:
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID

    ds.save_as(args.output, write_like_original=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
