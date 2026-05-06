/**
 * Synthetic avatar renderer — human-looking body.
 *
 * Pose source: MediaPipe 3D keypoints (x, y in world-space metres).
 * Depth (Z) is intentionally ignored — the heuristic depth estimate is
 * unreliable for non-frontal / bent-over poses and causes the avatar to
 * thrash front-to-back.  Setting Z=0 collapses the pose onto the XY plane,
 * which is always correct (it matches the 2D video projection).
 *
 * Scale is normalised to a canonical 1.7 m body height every frame so the
 * avatar looks correct regardless of how close the person is to the camera.
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

const Y_AXIS        = new THREE.Vector3(0, 1, 0);
const CANONICAL_H   = 1.7;   // metres — target body height
const MIN_CONF      = 0.15;

// ---- Torso geometry ----
// Trapezoidal prism: shoulder end wider than hip end.
// All coords normalised to [-0.5, 0.5]; scaled per frame.
function createTorsoGeo() {
  const ws = 0.50, ds = 0.27;  // shoulder half-width / half-depth
  const wh = 0.40, dh = 0.22;  // hip      half-width / half-depth

  const pos = new Float32Array([
    -ws,  0.5,  ds,   // 0 shoulder FL
     ws,  0.5,  ds,   // 1 shoulder FR
     ws,  0.5, -ds,   // 2 shoulder BR
    -ws,  0.5, -ds,   // 3 shoulder BL
    -wh, -0.5,  dh,   // 4 hip FL
     wh, -0.5,  dh,   // 5 hip FR
     wh, -0.5, -dh,   // 6 hip BR
    -wh, -0.5, -dh,   // 7 hip BL
  ]);

  const idx = [
    0,2,1, 0,3,2,   // top
    4,5,6, 4,6,7,   // bottom
    0,1,5, 0,5,4,   // front
    3,7,6, 3,6,2,   // back
    3,0,4, 3,4,7,   // left
    1,2,6, 1,6,5,   // right
  ];

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---- Limb defs: [name, idxA (body), idxB (extremity), rA, rB] ----
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

// Joint spheres: [name, idx, radius]
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
    this.group  = new THREE.Group();
    this._mat   = new THREE.MeshPhongMaterial({
      color:     0x3b82f6,
      emissive:  0x06122a,
      specular:  0x90c8ff,
      shininess: 70,
      side: THREE.DoubleSide,
    });
    this._parts = {};
    this._buildMeshes();

    // Expose the computed avatar centre so AvatarViewer can track camera.
    this.avatarCenter = new THREE.Vector3(0, 1, 0);
  }

  _buildMeshes() {
    const { _mat: mat, _parts: p, group: g } = this;
    const add = m => { m.castShadow = true; g.add(m); return m; };

    p.torso = add(new THREE.Mesh(createTorsoGeo(), mat));
    p.head  = add(new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat));
    p.neck  = add(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.055, 1, 8), mat));

    for (const [name, , , rA, rB] of LIMB_DEFS) {
      // radiusTop = rB (extremity, narrower), radiusBottom = rA (body, wider)
      p[name] = add(new THREE.Mesh(new THREE.CylinderGeometry(rB, rA, 1, 10, 1), mat));
    }

    for (const [name, , r] of JOINT_DEFS) {
      p[name] = add(new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat));
    }
  }

  // ---- update ----

  update(keypoints3d) {
    if (!keypoints3d) return;

    // ── Step 1: raw XY positions, Z = 0 ──────────────────────────────────
    // We deliberately ignore the heuristic depth (kp.z) — it is unreliable
    // for bent-over / side-view poses and causes the avatar to distort.
    const raw = (idx) => {
      const kp = keypoints3d[idx];
      if (!kp || kp.confidence < MIN_CONF) return null;
      return new THREE.Vector3(kp.x, kp.y, 0);
    };

    // ── Step 2: compute scale → normalise body height to CANONICAL_H ─────
    const headCands = [raw(IDX.NOSE), raw(IDX.LEFT_EAR), raw(IDX.RIGHT_EAR)].filter(Boolean);
    const anklePts  = [raw(IDX.LEFT_ANKLE), raw(IDX.RIGHT_ANKLE)].filter(Boolean);

    let scale = 1.0;
    if (headCands.length && anklePts.length) {
      const headY  = headCands.reduce((s, v) => s + v.y, 0) / headCands.length;
      const floorY = Math.min(...anklePts.map(v => v.y));
      const projH  = headY - floorY;
      if (projH > 0.05) scale = CANONICAL_H / projH;
    } else {
      // Fallback: torso length (shoulder–hip ≈ 35 % of body height)
      const ls = raw(IDX.LEFT_SHOULDER), rs = raw(IDX.RIGHT_SHOULDER);
      const lh = raw(IDX.LEFT_HIP),      rh = raw(IDX.RIGHT_HIP);
      if (ls && rs && lh && rh) {
        const shMid  = new THREE.Vector3().addVectors(ls, rs).multiplyScalar(0.5);
        const hipMid = new THREE.Vector3().addVectors(lh, rh).multiplyScalar(0.5);
        const tLen   = shMid.distanceTo(hipMid);
        if (tLen > 0.02) scale = (CANONICAL_H * 0.35) / tLen;
      }
    }
    scale = Math.max(0.3, Math.min(scale, 6.0)); // sanity clamp

    // ── Step 3: scaled getter ─────────────────────────────────────────────
    const get = (idx) => {
      const p = raw(idx);
      return p ? p.multiplyScalar(scale) : null;
    };

    // ── Step 4: centering ─────────────────────────────────────────────────
    const lHip = get(IDX.LEFT_HIP),    rHip = get(IDX.RIGHT_HIP);
    const lSh  = get(IDX.LEFT_SHOULDER), rSh = get(IDX.RIGHT_SHOULDER);
    const lAnk = get(IDX.LEFT_ANKLE),  rAnk = get(IDX.RIGHT_ANKLE);
    const lHee = get(IDX.LEFT_HEEL),   rHee = get(IDX.RIGHT_HEEL);

    let cx = 0, cy = 0;

    if (lHip && rHip)  cx = (lHip.x + rHip.x) / 2;
    else if (lSh && rSh) cx = (lSh.x  + rSh.x)  / 2;

    const floorPts = [lAnk, rAnk, lHee, rHee].filter(Boolean);
    if (floorPts.length) cy = Math.min(...floorPts.map(v => v.y));

    this.group.position.set(-cx, -cy, 0);

    // Expose avatar centre for camera tracking
    const hipY = lHip && rHip ? (lHip.y + rHip.y) / 2 - cy : CANONICAL_H * 0.53;
    this.avatarCenter.set(0, Math.max(0.3, hipY), 0);

    // ── Step 5: limbs ─────────────────────────────────────────────────────
    for (const [name, idxA, idxB] of LIMB_DEFS) {
      this._placeCylinder(this._parts[name], get(idxA), get(idxB));
    }

    // ── Step 6: joint spheres ─────────────────────────────────────────────
    for (const [name, idx] of JOINT_DEFS) {
      const pos  = get(idx);
      const mesh = this._parts[name];
      if (!pos) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.position.copy(pos);
    }

    // ── Step 7: torso ─────────────────────────────────────────────────────
    if (lSh && rSh && lHip && rHip) {
      const shMid  = new THREE.Vector3().addVectors(lSh,  rSh).multiplyScalar(0.5);
      const hipMid = new THREE.Vector3().addVectors(lHip, rHip).multiplyScalar(0.5);
      const dir    = new THREE.Vector3().subVectors(shMid, hipMid);
      const len    = dir.length();
      if (len > 0.05) {
        const torso = this._parts.torso;
        torso.visible = true;
        torso.position.addVectors(shMid, hipMid).multiplyScalar(0.5);
        const w = Math.max(lSh.distanceTo(rSh), 0.15);
        torso.scale.set(w, len, w);
        torso.quaternion.setFromUnitVectors(Y_AXIS, dir.clone().normalize());
      }
    } else {
      this._parts.torso.visible = false;
    }

    // ── Step 8: neck ──────────────────────────────────────────────────────
    if (lSh && rSh) {
      const shMid  = new THREE.Vector3().addVectors(lSh, rSh).multiplyScalar(0.5);
      const neckLen = Math.max(lSh.distanceTo(rSh), 0.15) * 0.30;
      const neckTop = shMid.clone().addScaledVector(Y_AXIS, neckLen);
      this._placeCylinder(this._parts.neck, shMid, neckTop);
    } else {
      this._parts.neck.visible = false;
    }

    // ── Step 9: head ──────────────────────────────────────────────────────
    const nosePt  = get(IDX.NOSE);
    const learPt  = get(IDX.LEFT_EAR);
    const rearPt  = get(IDX.RIGHT_EAR);
    const cands   = [nosePt, learPt, rearPt].filter(Boolean);
    const headMesh = this._parts.head;

    if (cands.length > 0) {
      const pos = cands.reduce((a, v) => a.add(v), new THREE.Vector3())
                       .divideScalar(cands.length);
      if (nosePt && cands.length > 1) pos.y += 0.04 * scale;

      const r = lSh && rSh ? lSh.distanceTo(rSh) * 0.30 : CANONICAL_H * 0.075;
      headMesh.visible = true;
      headMesh.position.copy(pos);
      headMesh.scale.setScalar(Math.max(0.09, Math.min(r, 0.18)));
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

  // Orient cylinder so its Y axis runs from pA (bottom) to pB (top).
  _placeCylinder(mesh, pA, pB) {
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
