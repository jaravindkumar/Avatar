/**
 * Synthetic avatar renderer — human-looking body.
 *
 * - Solid trapezoidal torso (wider at shoulders, narrower at hips)
 * - Tapered limb cylinders (thick at body end, thinner at extremity)
 * - Joint spheres at elbows, knees, shoulders, hips
 * - Head sphere + short neck cylinder
 * - Auto-centers + floor-aligns every frame (person doesn't need to be
 *   centred in the video)
 */

import * as THREE from 'three';

// ---- MediaPipe indices ----
const IDX = {
  NOSE: 0, LEFT_EAR: 7, RIGHT_EAR: 8,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,    RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,    RIGHT_WRIST: 16,
  LEFT_HIP: 23,      RIGHT_HIP: 24,
  LEFT_KNEE: 25,     RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,    RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,     RIGHT_HEEL: 30,
};

const Y_AXIS = new THREE.Vector3(0, 1, 0);

// ---- Torso geometry ----
// Trapezoidal prism: normalized so shoulder span = 1 unit wide.
// Use scale.set(shoulderWidth, torsoLen, shoulderWidth) each frame.
function createTorsoGeo() {
  const ws = 0.50, hs = 0.27;  // shoulder: half-width, half-depth
  const wh = 0.40, hh = 0.22;  // hip:      half-width, half-depth

  // 8 corner vertices (Y up, Z toward camera)
  const pos = new Float32Array([
    -ws,  0.5,  hs,   // 0  shoulder front-left
     ws,  0.5,  hs,   // 1  shoulder front-right
     ws,  0.5, -hs,   // 2  shoulder back-right
    -ws,  0.5, -hs,   // 3  shoulder back-left
    -wh, -0.5,  hh,   // 4  hip front-left
     wh, -0.5,  hh,   // 5  hip front-right
     wh, -0.5, -hh,   // 6  hip back-right
    -wh, -0.5, -hh,   // 7  hip back-left
  ]);

  // Outward-facing triangles (CCW from outside)
  const idx = [
    0,2,1,  0,3,2,   // top
    4,5,6,  4,6,7,   // bottom
    0,1,5,  0,5,4,   // front
    3,7,6,  3,6,2,   // back
    3,0,4,  3,4,7,   // left
    1,2,6,  1,6,5,   // right
  ];

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---- Limb definitions ----
// [name, idxA (body end), idxB (extremity end), rA, rB]
const LIMB_DEFS = [
  ['l_upper_arm', IDX.LEFT_SHOULDER,  IDX.LEFT_ELBOW,   0.068, 0.054],
  ['l_forearm',   IDX.LEFT_ELBOW,     IDX.LEFT_WRIST,   0.054, 0.038],
  ['r_upper_arm', IDX.RIGHT_SHOULDER, IDX.RIGHT_ELBOW,  0.068, 0.054],
  ['r_forearm',   IDX.RIGHT_ELBOW,    IDX.RIGHT_WRIST,  0.054, 0.038],
  ['l_thigh',     IDX.LEFT_HIP,       IDX.LEFT_KNEE,    0.092, 0.074],
  ['l_shin',      IDX.LEFT_KNEE,      IDX.LEFT_ANKLE,   0.070, 0.050],
  ['r_thigh',     IDX.RIGHT_HIP,      IDX.RIGHT_KNEE,   0.092, 0.074],
  ['r_shin',      IDX.RIGHT_KNEE,     IDX.RIGHT_ANKLE,  0.070, 0.050],
];

// [name, idx, radius]
const JOINT_DEFS = [
  ['shl',  IDX.LEFT_SHOULDER,  0.072],
  ['shr',  IDX.RIGHT_SHOULDER, 0.072],
  ['elbl', IDX.LEFT_ELBOW,     0.055],
  ['elbr', IDX.RIGHT_ELBOW,    0.055],
  ['wrl',  IDX.LEFT_WRIST,     0.040],
  ['wrr',  IDX.RIGHT_WRIST,    0.040],
  ['hipl', IDX.LEFT_HIP,       0.085],
  ['hipr', IDX.RIGHT_HIP,      0.085],
  ['knl',  IDX.LEFT_KNEE,      0.072],
  ['knr',  IDX.RIGHT_KNEE,     0.072],
  ['ankl', IDX.LEFT_ANKLE,     0.048],
  ['ankr', IDX.RIGHT_ANKLE,    0.048],
];

// ---- Renderer ----

export class SyntheticAvatarRenderer {
  constructor() {
    this.group = new THREE.Group();
    this._mat  = new THREE.MeshPhongMaterial({
      color:     0x3b82f6,
      emissive:  0x06122a,
      specular:  0x90c8ff,
      shininess: 70,
      side: THREE.DoubleSide,
    });
    this._parts = {};
    this._buildMeshes();
  }

  _buildMeshes() {
    const { _mat: mat, _parts: p, group: g } = this;
    const add = (mesh) => { mesh.castShadow = true; g.add(mesh); return mesh; };

    // Torso (unit-normalised, scaled per frame)
    p.torso = add(new THREE.Mesh(createTorsoGeo(), mat));

    // Head (unit sphere, scaled per frame)
    p.head = add(new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat));

    // Neck
    p.neck = add(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.055, 1, 8), mat));

    // Tapered limb cylinders
    for (const [name, , , rA, rB] of LIMB_DEFS) {
      // CylinderGeometry(radiusTop, radiusBottom, height, segments)
      // top  (+Y) = joint B (extremity end) = narrower
      // bottom (−Y) = joint A (body end)   = wider
      p[name] = add(new THREE.Mesh(
        new THREE.CylinderGeometry(rB, rA, 1, 10, 1), mat
      ));
    }

    // Joint spheres (fixed size, not scaled)
    for (const [name, , r] of JOINT_DEFS) {
      p[name] = add(new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat));
    }
  }

  // ---- Per-frame update ----

  update(keypoints3d) {
    if (!keypoints3d) return;

    const get = (idx) => {
      const kp = keypoints3d[idx];
      if (!kp || kp.confidence < 0.15) return null;
      return new THREE.Vector3(kp.x, kp.y, -kp.z); // flip Z for Three.js
    };

    // --- Auto-center: put hip midpoint at XZ origin, feet at Y=0 ---
    const lHip   = get(IDX.LEFT_HIP),    rHip   = get(IDX.RIGHT_HIP);
    const lSh    = get(IDX.LEFT_SHOULDER), rSh   = get(IDX.RIGHT_SHOULDER);
    const lAnkle = get(IDX.LEFT_ANKLE),  rAnkle = get(IDX.RIGHT_ANKLE);
    const lHeel  = get(IDX.LEFT_HEEL),   rHeel  = get(IDX.RIGHT_HEEL);

    let cx = 0, cy = 0, cz = 0;

    if (lHip && rHip) {
      cx = (lHip.x + rHip.x) / 2;
      cz = (lHip.z + rHip.z) / 2;
    } else if (lSh && rSh) {
      cx = (lSh.x + rSh.x) / 2;
      cz = (lSh.z + rSh.z) / 2;
    }

    const floorPts = [lAnkle, rAnkle, lHeel, rHeel].filter(Boolean);
    if (floorPts.length) cy = Math.min(...floorPts.map(v => v.y));

    this.group.position.set(-cx, -cy, -cz);

    // --- Limbs ---
    for (const [name, idxA, idxB] of LIMB_DEFS) {
      this._placeLimb(this._parts[name], get(idxA), get(idxB));
    }

    // --- Joint spheres ---
    for (const [name, idx] of JOINT_DEFS) {
      const pos = get(idx);
      const mesh = this._parts[name];
      if (!pos) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.position.copy(pos);
    }

    // --- Torso ---
    if (lSh && rSh && lHip && rHip) {
      const shMid  = new THREE.Vector3().addVectors(lSh, rSh).multiplyScalar(0.5);
      const hipMid = new THREE.Vector3().addVectors(lHip, rHip).multiplyScalar(0.5);
      const dir    = new THREE.Vector3().subVectors(shMid, hipMid);
      const len    = dir.length();

      if (len > 0.05) {
        const torso = this._parts.torso;
        const w = lSh.distanceTo(rSh);
        torso.visible = true;
        torso.position.addVectors(shMid, hipMid).multiplyScalar(0.5);
        torso.scale.set(w, len, w);
        torso.quaternion.setFromUnitVectors(Y_AXIS, dir.clone().normalize());
      }
    } else {
      this._parts.torso.visible = false;
    }

    // --- Neck ---
    if (lSh && rSh) {
      const shMid = new THREE.Vector3().addVectors(lSh, rSh).multiplyScalar(0.5);
      const w = lSh.distanceTo(rSh);
      const neckLen = w * 0.30;
      const neckTop = shMid.clone().addScaledVector(Y_AXIS, neckLen);
      this._placeLimb(this._parts.neck, shMid, neckTop);
    } else {
      this._parts.neck.visible = false;
    }

    // --- Head ---
    const nose = get(IDX.NOSE);
    const lear = get(IDX.LEFT_EAR), rear = get(IDX.RIGHT_EAR);
    const cands = [nose, lear, rear].filter(Boolean);
    const headMesh = this._parts.head;

    if (cands.length > 0) {
      const pos = cands
        .reduce((acc, v) => acc.add(v), new THREE.Vector3())
        .divideScalar(cands.length);
      if (nose && cands.length > 1) pos.y += 0.04;
      const r = lSh && rSh ? lSh.distanceTo(rSh) * 0.30 : 0.12;
      headMesh.visible = true;
      headMesh.position.copy(pos);
      headMesh.scale.setScalar(Math.max(0.09, Math.min(r, 0.15)));
    } else if (lSh && rSh) {
      const pos = new THREE.Vector3().addVectors(lSh, rSh).multiplyScalar(0.5);
      pos.y += 0.28;
      headMesh.visible = true;
      headMesh.position.copy(pos);
      headMesh.scale.setScalar(0.12);
    } else {
      headMesh.visible = false;
    }
  }

  // Orient a cylinder/mesh so its Y axis runs from pA to pB.
  _placeLimb(mesh, pA, pB) {
    if (!pA || !pB) { mesh.visible = false; return; }
    const dir = new THREE.Vector3().subVectors(pB, pA);
    const len = dir.length();
    if (len < 0.005) { mesh.visible = false; return; }

    mesh.visible = true;
    mesh.position.addVectors(pA, pB).multiplyScalar(0.5);
    mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(Y_AXIS, dir.divideScalar(len));
  }

  setWireframe(enabled) { this._mat.wireframe = enabled; }

  dispose() {
    this.group.traverse(o => o.geometry?.dispose());
    this._mat.dispose();
  }
}
