#!/usr/bin/env python3
import subprocess
import sys
import tempfile
from pathlib import Path

import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "isolate_dicom_uids.py"


def write_dicom(path: Path) -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    meta.MediaStorageSOPInstanceUID = "1.2.826.0.1.3680043.8.498.999.1"
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    ds.PatientName = "TEST"
    ds.StudyInstanceUID = "1.2.826.0.1.3680043.8.498.100"
    ds.SeriesInstanceUID = "1.2.826.0.1.3680043.8.498.200"
    ds.SOPInstanceUID = "1.2.826.0.1.3680043.8.498.300"
    ds.Modality = "CT"
    ds.InstanceNumber = "1"
    ds.save_as(str(path), write_like_original=False)


def isolate(source: Path, output: Path, namespace: str) -> pydicom.dataset.Dataset:
    subprocess.check_call(
        [
            sys.executable,
            str(SCRIPT),
            "--input",
            str(source),
            "--output",
            str(output),
            "--namespace",
            namespace,
        ]
    )
    return pydicom.dcmread(str(output), force=True)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="dicom-uid-isolation-test-") as tmp:
        tmpdir = Path(tmp)
        source = tmpdir / "source.dcm"
        write_dicom(source)

        case_1 = isolate(source, tmpdir / "case-1.dcm", "mapdr-study-1")
        case_1_again = isolate(source, tmpdir / "case-1-again.dcm", "mapdr-study-1")
        case_4 = isolate(source, tmpdir / "case-4.dcm", "mapdr-study-4")

        assert case_1.StudyInstanceUID == case_1_again.StudyInstanceUID
        assert case_1.StudyInstanceUID != case_4.StudyInstanceUID
        assert case_1.SeriesInstanceUID != case_4.SeriesInstanceUID
        assert case_1.SOPInstanceUID != case_4.SOPInstanceUID
        assert case_1.file_meta.MediaStorageSOPInstanceUID == case_1.SOPInstanceUID

    print("dicom uid isolation regression passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
