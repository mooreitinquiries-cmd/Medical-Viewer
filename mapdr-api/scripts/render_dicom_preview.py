#!/usr/bin/env python3
import argparse

import numpy as np
import pydicom
from PIL import Image


def first_value(value, fallback=None):
    if value is None:
        return fallback
    if isinstance(value, (list, tuple)):
        return value[0] if value else fallback
    try:
        if hasattr(value, "__iter__") and not isinstance(value, (str, bytes)):
            return list(value)[0]
    except Exception:
        pass
    return value


def to_float(value, fallback):
    try:
        return float(first_value(value, fallback))
    except Exception:
        return fallback


def render(input_path, output_path, frame):
    ds = pydicom.dcmread(input_path)
    pixels = ds.pixel_array

    if pixels.ndim >= 3 and int(getattr(ds, "SamplesPerPixel", 1) or 1) == 1:
        pixels = pixels[min(max(frame, 0), pixels.shape[0] - 1)]

    arr = pixels.astype(np.float32)

    slope = to_float(getattr(ds, "RescaleSlope", 1), 1)
    intercept = to_float(getattr(ds, "RescaleIntercept", 0), 0)
    arr = arr * slope + intercept

    center = getattr(ds, "WindowCenter", None)
    width = getattr(ds, "WindowWidth", None)
    if center is not None and width is not None:
        center = to_float(center, 0)
        width = max(to_float(width, 1), 1)
        low = center - width / 2
        high = center + width / 2
    else:
        low = float(np.nanpercentile(arr, 1))
        high = float(np.nanpercentile(arr, 99))
        if high <= low:
            low = float(np.nanmin(arr))
            high = float(np.nanmax(arr))

    if high <= low:
        high = low + 1

    arr = np.clip((arr - low) / (high - low), 0, 1)
    if str(getattr(ds, "PhotometricInterpretation", "")).upper() == "MONOCHROME1":
        arr = 1 - arr

    arr8 = (arr * 255).astype(np.uint8)

    if arr8.ndim == 3 and arr8.shape[-1] in (3, 4):
        image = Image.fromarray(arr8)
    else:
        image = Image.fromarray(arr8, mode="L")

    image.save(output_path, format="PNG")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--frame", type=int, default=0)
    args = parser.parse_args()
    render(args.input, args.output, args.frame)


if __name__ == "__main__":
    main()
