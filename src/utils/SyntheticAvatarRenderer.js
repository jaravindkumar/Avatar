/**
 * Synthetic avatar renderer.
 *
 * Builds a capsule-based humanoid directly from MediaPipe 3D keypoints.
 * No SMPL model file required.
 *
 * Each body segment = cylinder + two sphere end-caps, updated every frame.
 */

import * as THREE from 'three';

// MediaPipe landmark indices used for body segments
const IDX = {
  NOSE: 0,
  LEFT_EAR: 7,  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,    RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,    RIGHT_WRIST: 16,
  LEFT_HIP: 23,      RIGHT_HIP: 24,
  LEFT_KNEE: 25,     RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,    RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,     RIGHT_HEEL: 30,
};

// [namePrefix, landmarkA, landmarkB, cylinderRadius]
const LIMB_DEFS = [
  // Arms
  ['l_upper_arm',  IDX.LEFT_SHOULDER,  IDX.LEFT_ELBOW,   0.050],
  ['l_forearm',    IDX.LEFT_ELBOW,     IDX.LEFT_WRIST,   0.038],
  ['r_upper_arm',  IDX.RIGHT_SHOULDER, IDX.RIGHT_ELBOW,  0.050],
  ['r_forearm',    IDX.RIGHT_ELBOW,    IDX.RIGHT_WRIST,  0.038],
  // Legs
  ['l_thigh',      IDX.LEFT_HIP,       IDX.LEFT_KNEE,    0.068],
  ['l_shin',       IDX.LEFT_KNEE,      IDX.LEFT_ANKLE,   0.050],
  ['r_thigh',      IDX.RIGHT_HIP,      IDX.RIGHT_KNEE,   0.068],
  ['r_shin',       IDX.RIGHT_KNEE,     IDX.RIGHT_ANKLE,  0.050],
  // Feet
  ['l_foot',       IDX.LEFT_ANKLE,     IDX.LEFT_HEEL,    0.038],
  ['r_foot',       IDX.RIGHT_ANKLE,    IDX.RIGHT_HEEL,   0.038],
  // Torso frame
  ['shoulder_bar', IDX.LEFT_SHOULDER,  IDX.RIGHT_SHOULDER, 0.040],
  ['hip_bar',      IDX.LEFT_HIP,       IDX.RIGHT_HIP,      0.040],
  ['l_side',       IDX.LEFT_SHOULDER,  IDX.LEFT_HIP,       0.040],
  ['r_side',       IDX.RIGHT_SHOULDER, IDX.RIGHT_HIP,      0.040],
];

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class SyntheticAvatarRenderer {
  /**
   * @param {THREE.Material} [material] - optional override material
   */
  constructor(material) {
    this.group = new THREE.Group();

    this._mat = material ?? new THREE.MeshPhongMaterial({
      color: 0x3b82f6,
      emissive: 0x0a1a3a,
      specular: 0x90c0ff,
      shininess: 50,
      side: THREE.DoubleSide,
    });

    this._capMat = this._mat.clone();

    // Per-limb: { cyl, capA, capB, def }
    this._limbs = [];
    this._headMesh = null;

    this._initMeshes();
  }

  _initMeshes() {
    // Limbs
    for (const def of LIMB_DEFS) {
      const [name, , , r] = def;

      // Unit-length cylinder; we'll scale Y each frame
      const cylGeo  = new THREE.CylinderGeometry(r, r, 1, 10, 1);
      const capGeo  = new THREE.SphereGeometry(r, 8, 6);

      const cyl  = new THREE.Mesh(cylGeo,  this._mat);
      const capA = new THREE.Mesh(capGeo,  this._capMat);
      const capB = new THREE.Mesh(capGeo,  this._capMat);

      cyl.castShadow  = capA.castShadow = capB.castShadow = true;
      cyl.name = name;

      this.group.add(cyl, capA, capB);
      this._limbs.push({ cyl, capA, capB, def });
    }

    // Head sphere
    const headGeo = new THREE.SphereGeometry(0.11, 14, 10);
    this._headMesh = new THREE.Mesh(headGeo, this._mat);
    this._headMesh.castShadow = true;
    this._headMesh.name = 'head';
    this.group.add(this._headMesh);
  }

  /**
   * Update all meshes from a new set of 3D keypoints.
   * @param {Array} keypoints3d - [{x, y, z, confidence}] (33 MediaPipe points)
   */
  update(keypoints3d) {
    if (!keypoints3d) return;

    const getVec = (idx) => {
      const kp = keypoints3d[idx];
      if (!kp || kp.confidence < 0.15) return null;
      // Flip Z: MediaPipe depth points towards camera; Three.js Z points out
      return new THREE.Vector3(kp.x, kp.y, -kp.z);
    };

    // --- Limbs ---
    for (const { cyl, capA, capB, def } of this._limbs) {
      const [, idxA, idxB] = def;
      const pA = getVec(idxA);
      const pB = getVec(idxB);

      if (!pA || !pB) {
        cyl.visible = capA.visible = capB.visible = false;
        continue;
      }

      cyl.visible = capA.visible = capB.visible = true;

      const dir    = new THREE.Vector3().subVectors(pB, pA);
      const length = dir.length();
      const mid    = new THREE.Vector3().addVectors(pA, pB).multiplyScalar(0.5);

      cyl.position.copy(mid);
      cyl.scale.set(1, length, 1);
      cyl.quaternion.setFromUnitVectors(Y_AXIS, dir.clone().normalize());

      capA.position.copy(pA);
      capB.position.copy(pB);
    }

    // --- Head ---
    const nose     = getVec(IDX.NOSE);
    const leftEar  = getVec(IDX.LEFT_EAR);
    const rightEar = getVec(IDX.RIGHT_EAR);
    const lShoulder = getVec(IDX.LEFT_SHOULDER);
    const rShoulder = getVec(IDX.RIGHT_SHOULDER);

    // Best head position: avg of available head landmarks
    const headCandidates = [nose, leftEar, rightEar].filter(Boolean);

    if (headCandidates.length > 0) {
      const headPos = headCandidates
        .reduce((acc, v) => acc.add(v), new THREE.Vector3())
        .divideScalar(headCandidates.length);

      // Lift slightly above ear/nose average
      if (nose && (leftEar || rightEar)) headPos.y += 0.06;

      this._headMesh.position.copy(headPos);
      this._headMesh.visible = true;
    } else if (lShoulder && rShoulder) {
      // Fallback: extrapolate from shoulders
      const neckPos = new THREE.Vector3().addVectors(lShoulder, rShoulder).multiplyScalar(0.5);
      neckPos.y += 0.25;
      this._headMesh.position.copy(neckPos);
      this._headMesh.visible = true;
    } else {
      this._headMesh.visible = false;
    }
  }

  setWireframe(enabled) {
    this._mat.wireframe     = enabled;
    this._capMat.wireframe  = enabled;
  }

  dispose() {
    this.group.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
    });
    this._mat.dispose();
    this._capMat.dispose();
  }
}
