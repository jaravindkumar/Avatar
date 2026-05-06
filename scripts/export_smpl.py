"""
SMPL Model Export Script
========================
Run this once locally to generate public/smpl_model.bin (~25 MB, 4x smaller than JSON).

Steps:
  1. Download SMPL from http://smpl.is.tue.mpg.de/ (free, requires registration)
  2. Place basicModel_m_lbs_10_207_0_v1.0.0.pkl in this scripts/ directory
  3. pip install numpy scipy
  4. python scripts/export_smpl.py
  5. Serves automatically from /smpl_model.bin in the React app

Binary format:
  [4 bytes uint32 LE]  header_length
  [header_length bytes] UTF-8 JSON: {"arrays": [{name, dtype, shape, offset, bytes}, ...]}
  [raw binary data]    arrays concatenated (float32 or int32, little-endian)

Without smpl_model.bin the app runs in synthetic capsule avatar mode (no model file needed).
"""

import pickle
import json
import struct
import numpy as np
import sys
import os

SMPL_PKL = os.path.join(os.path.dirname(__file__), "basicModel_m_lbs_10_207_0_v1.0.0.pkl")
OUTPUT   = os.path.join(os.path.dirname(__file__), "..", "public", "smpl_model.bin")


def to_array(x, dtype=np.float32):
    if hasattr(x, "toarray"):
        x = x.toarray()
    if hasattr(x, "r"):
        x = x.r
    return np.array(x, dtype=dtype)


def main():
    if not os.path.exists(SMPL_PKL):
        print(f"ERROR: SMPL model not found at:\n  {SMPL_PKL}")
        print("\nDownload from:  http://smpl.is.tue.mpg.de/")
        print("(Free for research use – registration required)")
        sys.exit(1)

    print(f"Loading {SMPL_PKL} ...")
    with open(SMPL_PKL, "rb") as f:
        model = pickle.load(f, encoding="latin1")

    arrays = [
        ("v_template",    to_array(model["v_template"],    np.float32)),
        ("J_regressor",   to_array(model["J_regressor"],   np.float32)),
        ("weights",       to_array(model["weights"],        np.float32)),
        ("posedirs",      to_array(model["posedirs"],       np.float32)),
        ("shapedirs",     to_array(model["shapedirs"],      np.float32)),
        ("kintree_table", to_array(model["kintree_table"],  np.int32)),
        ("faces",         to_array(model["f"],              np.int32)),
        ("mean_pose",     np.zeros(72,  dtype=np.float32)),
        ("mean_shape",    np.zeros(10,  dtype=np.float32)),
    ]

    # Build metadata: compute byte offsets in the data block
    meta = []
    offset = 0
    for name, arr in arrays:
        dtype_str = "float32" if arr.dtype == np.float32 else "int32"
        nbytes    = arr.nbytes
        meta.append({
            "name":   name,
            "dtype":  dtype_str,
            "shape":  list(arr.shape),
            "offset": offset,
            "bytes":  nbytes,
        })
        offset += nbytes

    header_json  = json.dumps({"arrays": meta}, separators=(',', ':')).encode("utf-8")
    header_len   = len(header_json)

    os.makedirs(os.path.dirname(os.path.abspath(OUTPUT)), exist_ok=True)
    print(f"Writing {OUTPUT} ...")
    with open(OUTPUT, "wb") as f:
        f.write(struct.pack("<I", header_len))   # 4-byte uint32 LE
        f.write(header_json)
        for _, arr in arrays:
            f.write(arr.tobytes())

    size_mb = os.path.getsize(OUTPUT) / (1024 * 1024)
    print(f"Done.  {size_mb:.1f} MB  (arrays: {', '.join(n for n,_ in arrays)})")


if __name__ == "__main__":
    main()
