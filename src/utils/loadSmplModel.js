/**
 * Load SMPL model from binary (.bin) or JSON (.json) format.
 *
 * Binary format (smpl_model.bin):
 *   [4 bytes uint32 LE]   header_length
 *   [header_length bytes] UTF-8 JSON: { arrays: [{name, dtype, shape, offset, bytes}] }
 *   [raw data]            arrays as float32 / int32, little-endian
 *
 * Returns the same flattened object shape used throughout the app.
 */

export async function loadSmplModel(binUrl, jsonUrl) {
  // Try binary first
  try {
    const resp = await fetch(binUrl);
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      return parseBin(buf);
    }
  } catch {
    // fall through to JSON
  }

  // Fallback: JSON
  if (jsonUrl) {
    const resp = await fetch(jsonUrl);
    if (resp.ok) {
      const raw = await resp.json();
      return flattenJson(raw);
    }
  }

  return null;
}

/**
 * Parse smpl_model.bin ArrayBuffer → flattened model object.
 */
export function parseBin(buf) {
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);                      // LE uint32
  const headerText = new TextDecoder().decode(buf.slice(4, 4 + headerLen));
  const { arrays } = JSON.parse(headerText);

  const dataStart = 4 + headerLen;
  const result = {};

  for (const { name, dtype, offset, bytes } of arrays) {
    const slice = buf.slice(dataStart + offset, dataStart + offset + bytes);
    result[name] = dtype === 'int32'
      ? new Int32Array(slice)
      : new Float32Array(slice);
  }

  return normalise(result);
}

/**
 * Flatten a JSON-parsed SMPL object (nested arrays → typed arrays).
 */
export function flattenJson(raw) {
  const toF32 = (arr) => {
    if (!arr) return null;
    if (Array.isArray(arr[0])) return new Float32Array(arr.flat(Infinity));
    return new Float32Array(arr);
  };
  return normalise({
    v_template:    toF32(raw.v_template),
    J_regressor:   toF32(raw.J_regressor),
    weights:       toF32(raw.weights),
    posedirs:      toF32(raw.posedirs),
    shapedirs:     toF32(raw.shapedirs),
    kintree_table: raw.kintree_table instanceof Int32Array
      ? raw.kintree_table
      : new Int32Array(raw.kintree_table?.flat?.() ?? raw.kintree_table),
    faces: raw.faces
      ? new Int32Array(Array.isArray(raw.faces[0]) ? raw.faces.flat() : raw.faces)
      : null,
    mean_pose:  toF32(raw.mean_pose)  ?? new Float32Array(72),
    mean_shape: toF32(raw.mean_shape) ?? new Float32Array(10),
  });
}

/** Ensure all required fields exist and have correct typed-array types. */
function normalise(m) {
  return {
    v_template:    m.v_template,
    J_regressor:   m.J_regressor,
    weights:       m.weights,
    posedirs:      m.posedirs,
    shapedirs:     m.shapedirs,
    kintree_table: m.kintree_table,
    faces:         m.faces,
    mean_pose:     m.mean_pose  ?? new Float32Array(72),
    mean_shape:    m.mean_shape ?? new Float32Array(10),
  };
}
