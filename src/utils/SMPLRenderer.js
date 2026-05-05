/**
 * SMPL Mesh Deformer + Three.js geometry builder.
 *
 * Given SMPL model data and per-frame pose/shape parameters, this module:
 *  1. Applies shape blend shapes (β) once per video
 *  2. Applies pose blend shapes (θ) per frame
 *  3. Performs Linear Blend Skinning (LBS)
 *  4. Returns an updated Three.js BufferGeometry
 *
 * SMPL model expected fields:
 *  v_template   : Float32Array(6890*3)        template mesh vertices
 *  shapedirs    : Float32Array(6890*3 * 10)   shape blend shapes [6890*3, 10]
 *  posedirs     : Float32Array(6890*3 * 207)  pose blend shapes
 *  weights      : Float32Array(6890*24)       LBS weights
 *  kintree_table: Array [24, 2]               joint hierarchy (row 0 = child, row 1 = parent)
 *  J_regressor  : Float32Array(24*6890)       joint regressor
 *  faces        : Uint32Array(N*3)            triangle face indices
 */

import * as THREE from 'three';
import { forwardKinematics, KINTREE } from './SMPLSolver.js';

const NUM_VERTS = 6890;
const NUM_JOINTS = 24;
const NUM_SHAPE = 10;
const NUM_POSE_BLEND = 207; // (24-1)*9 = 207 pose blend shape coefficients

export class SMPLRenderer {
  /**
   * @param {Object} model - parsed SMPL JSON data
   */
  constructor(model) {
    this.model = model;
    this.geometry = null;
    this.mesh = null;

    // Pre-compute rest-pose joint positions for LBS
    this._restJoints = this._computeRestJoints();

    // Initialise geometry once
    this._initGeometry();
  }

  // ---- Initialisation ----

  _computeRestJoints() {
    const { J_regressor, v_template } = this.model;
    const joints = new Float32Array(NUM_JOINTS * 3);
    for (let j = 0; j < NUM_JOINTS; j++) {
      for (let v = 0; v < NUM_VERTS; v++) {
        const w = J_regressor[j * NUM_VERTS + v];
        joints[j*3]   += w * v_template[v*3];
        joints[j*3+1] += w * v_template[v*3+1];
        joints[j*3+2] += w * v_template[v*3+2];
      }
    }
    return joints;
  }

  _initGeometry() {
    const { v_template, faces } = this.model;

    const positions = new Float32Array(v_template);
    const indices   = faces instanceof Uint32Array ? faces : new Uint32Array(faces.flat ? faces.flat() : faces);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.computeVertexNormals();
  }

  // ---- Per-frame deformation ----

  /**
   * Deform the mesh for one frame and update the Three.js geometry.
   * @param {Float32Array} pose   - 72 axis-angle values
   * @param {Float32Array} shape  - 10 shape coefficients
   * @param {Array}        globalTrans - [tx, ty, tz]
   */
  deform(pose, shape, globalTrans = [0, 0, 0]) {
    const { v_template, shapedirs, posedirs, weights } = this.model;

    const vDeformed = new Float32Array(NUM_VERTS * 3);

    // --- 1. Shape blend shapes ---
    for (let v = 0; v < NUM_VERTS; v++) {
      let dx = 0, dy = 0, dz = 0;
      for (let k = 0; k < NUM_SHAPE; k++) {
        const offset = (v * 3 * NUM_SHAPE) + k; // column-major [6890*3, 10]
        dx += shapedirs[offset * 3 + 0] * shape[k];
        dy += shapedirs[offset * 3 + 1] * shape[k];
        dz += shapedirs[offset * 3 + 2] * shape[k];
      }
      vDeformed[v*3]   = v_template[v*3]   + dx;
      vDeformed[v*3+1] = v_template[v*3+1] + dy;
      vDeformed[v*3+2] = v_template[v*3+2] + dz;
    }

    // --- 2. Pose blend shapes ---
    // Pose blend shape coefficients: rotation matrices minus identity, vectorised
    const poseCoeffs = this._computePoseCoeffs(pose);
    for (let v = 0; v < NUM_VERTS; v++) {
      let dx = 0, dy = 0, dz = 0;
      for (let k = 0; k < NUM_POSE_BLEND; k++) {
        const base = (v * NUM_POSE_BLEND + k) * 3;
        dx += posedirs[base]     * poseCoeffs[k];
        dy += posedirs[base + 1] * poseCoeffs[k];
        dz += posedirs[base + 2] * poseCoeffs[k];
      }
      vDeformed[v*3]   += dx;
      vDeformed[v*3+1] += dy;
      vDeformed[v*3+2] += dz;
    }

    // --- 3. Forward kinematics for LBS ---
    const jOff = this._computeJointOffsets(shape);
    const jointTransforms = this._computeJointTransforms(pose, jOff);

    // --- 4. Linear Blend Skinning ---
    const vSkinned = new Float32Array(NUM_VERTS * 3);
    for (let v = 0; v < NUM_VERTS; v++) {
      const vx = vDeformed[v*3], vy = vDeformed[v*3+1], vz = vDeformed[v*3+2];
      let ox = 0, oy = 0, oz = 0;

      for (let j = 0; j < NUM_JOINTS; j++) {
        const w = weights[v * NUM_JOINTS + j];
        if (w < 1e-6) continue;
        const T = jointTransforms[j]; // 4×4 row-major
        ox += w * (T[0]*vx + T[1]*vy + T[2]*vz + T[3]);
        oy += w * (T[4]*vx + T[5]*vy + T[6]*vz + T[7]);
        oz += w * (T[8]*vx + T[9]*vy + T[10]*vz + T[11]);
      }

      vSkinned[v*3]   = ox + globalTrans[0];
      vSkinned[v*3+1] = oy + globalTrans[1];
      vSkinned[v*3+2] = oz + globalTrans[2];
    }

    // --- 5. Update Three.js geometry ---
    const posAttr = this.geometry.getAttribute('position');
    posAttr.array.set(vSkinned);
    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  // ---- Helpers ----

  /**
   * Compute pose blend shape coefficients from axis-angle pose.
   * coeffs = rot_mat.flatten() - I.flatten() for joints 1..23
   */
  _computePoseCoeffs(pose) {
    const coeffs = new Float32Array(NUM_POSE_BLEND);
    const I = [1,0,0, 0,1,0, 0,0,1];

    for (let j = 1; j < NUM_JOINTS; j++) {
      const aa = [pose[j*3], pose[j*3+1], pose[j*3+2]];
      const R = this._aaToRotMat(aa);
      for (let k = 0; k < 9; k++) {
        coeffs[(j-1)*9 + k] = R[k] - I[k];
      }
    }
    return coeffs;
  }

  _aaToRotMat(aa) {
    const angle = Math.sqrt(aa[0]**2 + aa[1]**2 + aa[2]**2);
    if (angle < 1e-8) return [1,0,0, 0,1,0, 0,0,1];
    const [kx, ky, kz] = [aa[0]/angle, aa[1]/angle, aa[2]/angle];
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return [
      c + kx*kx*t,    kx*ky*t - kz*s, kx*kz*t + ky*s,
      ky*kx*t + kz*s, c + ky*ky*t,    ky*kz*t - kx*s,
      kz*kx*t - ky*s, kz*ky*t + kx*s, c + kz*kz*t,
    ];
  }

  /**
   * Shape-dependent joint offsets (parent-relative).
   */
  _computeJointOffsets(shape) {
    const { J_regressor, v_template, shapedirs } = this.model;
    // Shaped vertices
    const vs = new Float32Array(NUM_VERTS * 3);
    for (let v = 0; v < NUM_VERTS; v++) {
      vs[v*3]   = v_template[v*3];
      vs[v*3+1] = v_template[v*3+1];
      vs[v*3+2] = v_template[v*3+2];
      for (let k = 0; k < NUM_SHAPE; k++) {
        const base = (v * NUM_SHAPE + k) * 3;
        vs[v*3]   += shapedirs[base]   * shape[k];
        vs[v*3+1] += shapedirs[base+1] * shape[k];
        vs[v*3+2] += shapedirs[base+2] * shape[k];
      }
    }
    // World joints from shaped vertices
    const wj = new Float32Array(NUM_JOINTS * 3);
    for (let j = 0; j < NUM_JOINTS; j++) {
      for (let v = 0; v < NUM_VERTS; v++) {
        const w = J_regressor[j * NUM_VERTS + v];
        wj[j*3]   += w * vs[v*3];
        wj[j*3+1] += w * vs[v*3+1];
        wj[j*3+2] += w * vs[v*3+2];
      }
    }
    // Parent-relative
    const jOff = new Float32Array(NUM_JOINTS * 3);
    for (let j = 0; j < NUM_JOINTS; j++) {
      if (KINTREE[j] === -1) {
        jOff[j*3] = wj[j*3]; jOff[j*3+1] = wj[j*3+1]; jOff[j*3+2] = wj[j*3+2];
      } else {
        const p = KINTREE[j];
        jOff[j*3]   = wj[j*3]   - wj[p*3];
        jOff[j*3+1] = wj[j*3+1] - wj[p*3+1];
        jOff[j*3+2] = wj[j*3+2] - wj[p*3+2];
      }
    }
    return jOff;
  }

  /**
   * Compute global joint transforms (4×4) for LBS.
   * Returns array of 24 flat row-major 4×4 matrices, each relative to rest pose.
   */
  _computeJointTransforms(pose, jOff) {
    const globalTs = new Array(NUM_JOINTS);
    const restTs   = new Array(NUM_JOINTS);

    const restJoints = this._restJoints;

    // Build rest-pose global transforms (no rotation, just translation)
    for (let j = 0; j < NUM_JOINTS; j++) {
      const off = [jOff[j*3], jOff[j*3+1], jOff[j*3+2]];
      const identity = [0, 0, 0];
      const localT = this._makeTransform4(identity, off);
      if (KINTREE[j] === -1) {
        restTs[j] = localT;
      } else {
        restTs[j] = this._matMul4(restTs[KINTREE[j]], localT);
      }
    }

    // Posed global transforms
    for (let j = 0; j < NUM_JOINTS; j++) {
      const aa  = [pose[j*3], pose[j*3+1], pose[j*3+2]];
      const off = [jOff[j*3], jOff[j*3+1], jOff[j*3+2]];
      const localT = this._makeTransform4(aa, off);
      if (KINTREE[j] === -1) {
        globalTs[j] = localT;
      } else {
        globalTs[j] = this._matMul4(globalTs[KINTREE[j]], localT);
      }
    }

    // Relative transform: T_posed * T_rest_inv
    // For each joint, we need G_posed * (rest translation cancel)
    // Simplified: G_rel = G_posed * inv(G_rest)
    const relTs = new Array(NUM_JOINTS);
    for (let j = 0; j < NUM_JOINTS; j++) {
      // G_rest_inv for a pure-translation matrix is easy
      const G = restTs[j];
      // Inverse of translation-only 4x4: negate translation
      const G_inv = [
        1,0,0,-G[3],
        0,1,0,-G[7],
        0,0,1,-G[11],
        0,0,0,1,
      ];
      relTs[j] = this._matMul4(globalTs[j], G_inv);
    }

    return relTs;
  }

  _makeTransform4(aa, t) {
    const angle = Math.sqrt(aa[0]**2 + aa[1]**2 + aa[2]**2);
    let R;
    if (angle < 1e-8) {
      R = [1,0,0, 0,1,0, 0,0,1];
    } else {
      const [kx,ky,kz] = [aa[0]/angle, aa[1]/angle, aa[2]/angle];
      const c = Math.cos(angle), s = Math.sin(angle), t1 = 1-c;
      R = [
        c+kx*kx*t1,    kx*ky*t1-kz*s, kx*kz*t1+ky*s,
        ky*kx*t1+kz*s, c+ky*ky*t1,    ky*kz*t1-kx*s,
        kz*kx*t1-ky*s, kz*ky*t1+kx*s, c+kz*kz*t1,
      ];
    }
    return [
      R[0],R[1],R[2],t[0],
      R[3],R[4],R[5],t[1],
      R[6],R[7],R[8],t[2],
      0,0,0,1,
    ];
  }

  _matMul4(A, B) {
    const M = new Array(16).fill(0);
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        for (let k = 0; k < 4; k++)
          M[r*4+c] += A[r*4+k] * B[k*4+c];
    return M;
  }

  /**
   * Build a Three.js Mesh with the SMPL geometry.
   * @param {THREE.Material} material
   */
  buildMesh(material) {
    if (this.mesh) return this.mesh;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    return this.mesh;
  }

  dispose() {
    this.geometry?.dispose();
    this.mesh?.material?.dispose();
  }
}
