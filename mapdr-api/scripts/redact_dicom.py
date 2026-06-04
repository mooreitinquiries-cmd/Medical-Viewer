#!/usr/bin/env python3
import argparse
import csv
import os
import subprocess
import tempfile
from typing import List, Optional, Tuple

import numpy as np
import pydicom
from PIL import Image
from pydicom.uid import ExplicitVRLittleEndian, generate_uid


PHI_TAGS = [
    "PatientName",
    "PatientID",
    "PatientBirthDate",
    "PatientSex",
    "OtherPatientIDs",
    "OtherPatientNames",
    "PatientAddress",
    "PatientTelephoneNumbers",
    "InstitutionName",
    "InstitutionAddress",
    "ReferringPhysicianName",
    "PerformingPhysicianName",
    "OperatorsName",
    "PhysiciansOfRecord",
    "RequestingPhysician",
    "StationName",
    "DeviceSerialNumber",
    "AccessionNumber",
    "StudyID",
]


def clamp(v: int, lo: int, hi: int) -> int:
    return lo if v < lo else hi if v > hi else v


def parse_fixed_masks(spec: str) -> List[Tuple[float, float, float, float]]:
    if not spec:
        spec = "0,0,1,0.13;0,0.87,1,1;0,0,0.24,0.28;0.76,0,1,0.28"
    out: List[Tuple[float, float, float, float]] = []
    for part in spec.split(";"):
        part = part.strip()
        if not part:
            continue
        vals = [float(x.strip()) for x in part.split(",")]
        if len(vals) != 4:
            continue
        x1, y1, x2, y2 = vals
        out.append((max(0.0, x1), max(0.0, y1), min(1.0, x2), min(1.0, y2)))
    return out


def frame_to_u8(frame: np.ndarray) -> np.ndarray:
    arr = frame.astype(np.float32)
    lo = float(np.percentile(arr, 1))
    hi = float(np.percentile(arr, 99))
    if hi <= lo:
        lo = float(arr.min())
        hi = float(arr.max())
    if hi <= lo:
        return np.zeros(arr.shape[:2], dtype=np.uint8)
    norm = (arr - lo) * (255.0 / (hi - lo))
    norm = np.clip(norm, 0, 255).astype(np.uint8)
    if norm.ndim == 3:
        return norm[:, :, 0]
    return norm


def box_is_near_border(
    box: Tuple[int, int, int, int],
    width: int,
    height: int,
    border_margin_ratio: float,
) -> bool:
    x1, y1, x2, y2 = box
    margin_x = int(width * border_margin_ratio)
    margin_y = int(height * border_margin_ratio)
    return x1 <= margin_x or y1 <= margin_y or x2 >= (width - margin_x) or y2 >= (height - margin_y)


def run_ocr_boxes(gray_u8: np.ndarray, border_margin_ratio: float) -> List[Tuple[int, int, int, int]]:
    with tempfile.TemporaryDirectory(prefix="dicom-redact-") as td:
        png_path = os.path.join(td, "ocr.png")
        tsv_path = os.path.join(td, "ocr.tsv")
        Image.fromarray(gray_u8, mode="L").save(png_path)
        h, w = gray_u8.shape[:2]
        boxes: List[Tuple[int, int, int, int]] = []
        for psm in ("6", "11"):
            cmd = [
                "tesseract",
                png_path,
                os.path.join(td, "ocr"),
                "--oem",
                "1",
                "--psm",
                psm,
                "tsv",
            ]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if proc.returncode != 0 or not os.path.exists(tsv_path):
                continue
            with open(tsv_path, "r", encoding="utf-8", newline="") as f:
                reader = csv.DictReader(f, delimiter="\t")
                for row in reader:
                    text = (row.get("text") or "").strip()
                    if not text:
                        continue
                    conf_text = (row.get("conf") or "").strip()
                    try:
                        conf = float(conf_text)
                    except ValueError:
                        conf = -1.0
                    if conf < 30:
                        continue
                    try:
                        left = int(float(row.get("left", "0")))
                        top = int(float(row.get("top", "0")))
                        width = int(float(row.get("width", "0")))
                        height = int(float(row.get("height", "0")))
                    except ValueError:
                        continue
                    if width <= 0 or height <= 0:
                        continue
                    # Expand aggressively to reduce PHI miss risk.
                    pad_x = max(8, int(width * 0.2))
                    pad_y = max(8, int(height * 0.35))
                    box = (left - pad_x, top - pad_y, left + width + pad_x, top + height + pad_y)
                    if box_is_near_border(box, w, h, border_margin_ratio):
                        boxes.append(box)
        return boxes


def merge_boxes(boxes: List[Tuple[int, int, int, int]], gap: int = 14) -> List[Tuple[int, int, int, int]]:
    if not boxes:
        return []
    pending = sorted(boxes, key=lambda b: (b[1], b[0]))
    merged: List[List[int]] = []
    for box in pending:
        x1, y1, x2, y2 = box
        attached = False
        for m in merged:
            mx1, my1, mx2, my2 = m
            overlaps = not (x2 + gap < mx1 or mx2 + gap < x1 or y2 + gap < my1 or my2 + gap < y1)
            if overlaps:
                m[0] = min(mx1, x1)
                m[1] = min(my1, y1)
                m[2] = max(mx2, x2)
                m[3] = max(my2, y2)
                attached = True
                break
        if not attached:
            merged.append([x1, y1, x2, y2])
    return [(m[0], m[1], m[2], m[3]) for m in merged]


def normalized_black_value(frame: np.ndarray, photometric_interpretation: str) -> np.ndarray:
    photo = (photometric_interpretation or "").upper()
    if frame.ndim >= 3 and frame.shape[-1] >= 3 and photo.startswith("YBR"):
        base = np.array([0, 128, 128], dtype=np.float32)
        if frame.shape[-1] > 3:
            extra = np.zeros(frame.shape[-1] - 3, dtype=np.float32)
            base = np.concatenate([base, extra])
    elif frame.ndim >= 3:
        base = np.zeros(frame.shape[-1], dtype=np.float32)
    else:
        base = np.array(0, dtype=np.float32)

    dtype = frame.dtype
    if np.issubdtype(dtype, np.integer):
        ii = np.iinfo(dtype)
        return np.clip(base, ii.min, ii.max).astype(dtype)
    return base.astype(dtype)


def apply_box_mask(
    frame: np.ndarray,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    mask_value: Optional[np.ndarray] = None,
) -> None:
    h, w = frame.shape[:2]
    xa = clamp(x1, 0, w)
    xb = clamp(x2, 0, w)
    ya = clamp(y1, 0, h)
    yb = clamp(y2, 0, h)
    if xb <= xa or yb <= ya:
        return
    value = normalized_black_value(frame, "") if mask_value is None else mask_value
    if frame.ndim == 2:
        frame[ya:yb, xa:xb] = value
    else:
        frame[ya:yb, xa:xb, ...] = value


def apply_fixed_masks(
    frame: np.ndarray,
    masks: List[Tuple[float, float, float, float]],
    mask_value: Optional[np.ndarray] = None,
) -> None:
    h, w = frame.shape[:2]
    for x1f, y1f, x2f, y2f in masks:
        x1 = int(x1f * w)
        x2 = int(x2f * w)
        y1 = int(y1f * h)
        y2 = int(y2f * h)
        apply_box_mask(frame, x1, y1, x2, y2, mask_value=mask_value)


def clear_phi_tags(ds: pydicom.dataset.Dataset) -> None:
    for tag_name in PHI_TAGS:
        if hasattr(ds, tag_name):
            setattr(ds, tag_name, "")
    ds.remove_private_tags()
    ds.BurnedInAnnotation = "NO"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--enable-ocr", default="1")
    parser.add_argument("--enable-fixed-mask", default="1")
    parser.add_argument("--fixed-masks", default="")
    parser.add_argument("--ocr-border-margin", default="0.18")
    args = parser.parse_args()

    enable_ocr = args.enable_ocr == "1"
    enable_fixed = args.enable_fixed_mask == "1"
    fixed_masks = parse_fixed_masks(args.fixed_masks)
    try:
        ocr_border_margin = float(args.ocr_border_margin)
    except ValueError:
        ocr_border_margin = 0.18
    ocr_border_margin = max(0.05, min(0.35, ocr_border_margin))

    ds = pydicom.dcmread(args.input, force=True)
    clear_phi_tags(ds)

    if "PixelData" not in ds:
        ds.save_as(args.output, write_like_original=False)
        return 0

    try:
        pixels = ds.pixel_array
    except Exception as exc:
        print(f"PIXEL_DECODE_FAILED: {exc}", flush=True)
        return 2

    arr = np.asarray(pixels).copy()
    is_multiframe = arr.ndim >= 3 and getattr(ds, "NumberOfFrames", None) not in (None, "", "1")
    photometric = str(getattr(ds, "PhotometricInterpretation", "") or "")
    mask_value = normalized_black_value(arr[0] if is_multiframe else arr, photometric)

    sample_frame = arr[0] if is_multiframe else arr
    gray = frame_to_u8(sample_frame)
    ocr_boxes: List[Tuple[int, int, int, int]] = (
        run_ocr_boxes(gray, ocr_border_margin) if enable_ocr else []
    )
    ocr_boxes = merge_boxes(ocr_boxes)

    if is_multiframe:
        for i in range(arr.shape[0]):
            frame = arr[i]
            if enable_fixed:
                apply_fixed_masks(frame, fixed_masks, mask_value=mask_value)
            for box in ocr_boxes:
                apply_box_mask(frame, box[0], box[1], box[2], box[3], mask_value=mask_value)
            arr[i] = frame
    else:
        if enable_fixed:
            apply_fixed_masks(arr, fixed_masks, mask_value=mask_value)
        for box in ocr_boxes:
            apply_box_mask(arr, box[0], box[1], box[2], box[3], mask_value=mask_value)

    ds.PixelData = arr.tobytes()
    if getattr(ds, "file_meta", None) is None:
        ds.file_meta = pydicom.dataset.FileMetaDataset()
    if not getattr(ds.file_meta, "MediaStorageSOPClassUID", None):
        ds.file_meta.MediaStorageSOPClassUID = getattr(ds, "SOPClassUID", None) or generate_uid()
    if not getattr(ds.file_meta, "MediaStorageSOPInstanceUID", None):
        ds.file_meta.MediaStorageSOPInstanceUID = getattr(ds, "SOPInstanceUID", None) or generate_uid()
    if not getattr(ds.file_meta, "ImplementationClassUID", None):
        ds.file_meta.ImplementationClassUID = generate_uid()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    if hasattr(ds, "LossyImageCompression"):
        ds.LossyImageCompression = "00"

    ds.save_as(args.output, write_like_original=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
