"""
SMPL Model Export Script
========================
Run this once locally to generate public/smpl_model.json.

Steps:
  1. Download SMPL from http://smpl.is.tue.mpg.de/ (free, requires registration)
  2. Place basicModel_m_lbs_10_207_0_v1.0.0.pkl in this scripts/ directory
  3. pip install numpy scipy
  4. python scripts/export_smpl.py
  5. Serves automatically from /smpl_model.json in the React app

Without smpl_model.json the app runs in skeleton-only mode.
"""

import pickle
import json
import numpy as np
import sys
import os

SMPL_PKL = os.path.join(os.path.dirname(__file__), "basicModel_m_lbs_10_207_0_v1.0.0.pkl")
OUTPUT   = os.path.join(os.path.dirname(__file__), "..", "public", "smpl_model.json")


def to_list(x):
    if hasattr(x, "toarray"):
        x = x.toarray()
    if hasattr(x, "r"):
        x = x.r
    return np.array(x, dtype=np.float32).tolist()


def main():
    if not os.path.exists(SMPL_PKL):
        print(f"ERROR: SMPL model not found at:\n  {SMPL_PKL}")
        print("\nDownload from:  http://smpl.is.tue.mpg.de/")
        print("(Free for research use – registration required)")
        sys.exit(1)

    print(f"Loading {SMPL_PKL} ...")
    with open(SMPL_PKL, "rb") as f:
        model = pickle.load(f, encoding="latin1")

    data = {
        "v_template":    to_list(model["v_template"]),
        "J_regressor":   to_list(model["J_regressor"]),
        "weights":       to_list(model["weights"]),
        "posedirs":      to_list(model["posedirs"]),
        "shapedirs":     to_list(model["shapedirs"]),
        "kintree_table": to_list(model["kintree_table"]),
        "faces":         np.array(model["f"], dtype=np.int32).tolist(),
        "mean_pose":     np.zeros(72, dtype=np.float32).tolist(),
        "mean_shape":    np.zeros(10, dtype=np.float32).tolist(),
    }

    os.makedirs(os.path.dirname(os.path.abspath(OUTPUT)), exist_ok=True)
    print(f"Writing {OUTPUT} ...")
    with open(OUTPUT, "w") as f:
        json.dump(data, f)

    size_mb = os.path.getsize(OUTPUT) / (1024 * 1024)
    print(f"Done.  {size_mb:.1f} MB")


if __name__ == "__main__":
    main()
