#!/usr/bin/env python3
import argparse
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid


SECONDARY_CAPTURE_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.7"


def make_uid(namespace: str, kind: str, value: str) -> str:
    return generate_uid(entropy_srcs=[str(namespace), str(kind), str(value or "missing")])


def load_image(path: Path) -> tuple[np.ndarray, str, int]:
    image = Image.open(path)

    if image.mode in ("I;16", "I;16L", "I;16B", "I"):
        array = np.asarray(image)
        if array.dtype != np.uint16:
            array = np.clip(array, 0, 65535).astype(np.uint16)
        return array, "MONOCHROME2", 16

    if image.mode not in ("L", "RGB"):
        image = image.convert("RGB")

    array = np.asarray(image)
    if array.dtype != np.uint8:
        array = np.clip(array, 0, 255).astype(np.uint8)

    if array.ndim == 2:
        return array, "MONOCHROME2", 8

    if array.ndim == 3 and array.shape[-1] >= 3:
        return array[:, :, :3], "RGB", 8

    raise ValueError("Unsupported JPEG2000 image shape")


def write_dicom(input_path: Path, output_path: Path, namespace: str, source_name: str, instance_number: int) -> None:
    pixels, photometric, bits = load_image(input_path)
    rows = int(pixels.shape[0])
    cols = int(pixels.shape[1])
    samples_per_pixel = 3 if photometric == "RGB" else 1

    sop_instance_uid = make_uid(namespace, "SOPInstanceUID", f"{source_name}:{instance_number}")
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = SECONDARY_CAPTURE_IMAGE_STORAGE
    file_meta.MediaStorageSOPInstanceUID = sop_instance_uid
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = generate_uid()

    ds = FileDataset(str(output_path), {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    ds.SOPClassUID = SECONDARY_CAPTURE_IMAGE_STORAGE
    ds.SOPInstanceUID = sop_instance_uid
    ds.StudyInstanceUID = make_uid(namespace, "StudyInstanceUID", "raw-jpeg2000-study")
    ds.SeriesInstanceUID = make_uid(namespace, "SeriesInstanceUID", "raw-jpeg2000-series")
    ds.Modality = "OT"
    ds.PatientName = "JPEG2000^Upload"
    ds.PatientID = make_uid(namespace, "PatientID", "raw-jpeg2000-patient").split(".")[-1][:32]
    ds.StudyDescription = "JPEG2000 Upload"
    ds.SeriesDescription = "JPEG2000 Upload"
    ds.InstanceNumber = int(instance_number)
    ds.ImageType = ["DERIVED", "SECONDARY"]

    ds.Rows = rows
    ds.Columns = cols
    ds.SamplesPerPixel = samples_per_pixel
    ds.PhotometricInterpretation = photometric
    ds.BitsAllocated = bits
    ds.BitsStored = bits
    ds.HighBit = bits - 1
    ds.PixelRepresentation = 0
    if samples_per_pixel == 3:
        ds.PlanarConfiguration = 0

    ds.PixelData = np.ascontiguousarray(pixels).tobytes()
    ds.save_as(str(output_path), write_like_original=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--source-name", required=True)
    parser.add_argument("--instance-number", type=int, default=1)
    args = parser.parse_args()

    write_dicom(
        Path(args.input),
        Path(args.output),
        args.namespace,
        args.source_name,
        max(int(args.instance_number), 1),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
