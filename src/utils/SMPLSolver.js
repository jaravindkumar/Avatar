/**
 * SMPL IK Solver – pure JavaScript.
 *
 * Solves for SMPL pose parameters (θ) given a set of 3D target joint positions
 * extracted from the video.
 *
 * Algorithm:
 *   Simple gradient-descent optimisation with warm-starting from the previous
 *   frame.  Each iteration:
 *     1. Forward kinematics  → predicted joint positions
 *     2. Compute per-joint squared error weighted by confidence
 *     3. Finite-difference gradient w.r.t. θ
 *     4. Update θ with Adam-style momentum
 *
 * SMPL joint → MediaPipe landmark mapping (24 SMPL joints):
 *   SMPL uses a 24-joint skeleton; we map a subset to the 33 MediaPipe landmarks.
 */

// ----- SMPL joint indices -----
export const SMPL_JOINTS = {
  PELVIS: 0,
  LEFT_HIP: 1, RIGHT_HIP: 2,
  SPINE1: 3,
  LEFT_KNEE: 4, RIGHT_KNEE: 5,
  SPINE2: 6,
  LEFT_ANKLE: 7, RIGHT_ANKLE: 8,
  SPINE3: 9,
  LEFT_FOOT: 10, RIGHT_FOOT: 11,
  NECK: 12,
  LEFT_COLLAR: 13, RIGHT_COLLAR: 14,
  HEAD: 15,
  LEFT_SHOULDER: 16, RIGHT_SHOULDER: 17,
  LEFT_ELBOW: 18, RIGHT_ELBOW: 19,
  LEFT_WRIST: 20, RIGHT_WRIST: 21,
  LEFT_HAND: 22, RIGHT_HAND: 23,
};

// MediaPipe landmark index → SMPL joint index (best match)
const MP_TO_SMPL = {
  23: SMPL_JOINTS.LEFT_HIP,
  24: SMPL_JOINTS.RIGHT_HIP,
  25: SMPL_JOINTS.LEFT_KNEE,
  26: SMPL_JOINTS.RIGHT_KNEE,
  27: SMPL_JOINTS.LEFT_ANKLE,
  28: SMPL_JOINTS.RIGHT_ANKLE,
  11: SMPL_JOINTS.LEFT_SHOULDER,
  12: SMPL_JOINTS.RIGHT_SHOULDER,
  13: SMPL_JOINTS.LEFT_ELBOW,
  14: SMPL_JOINTS.RIGHT_ELBOW,
  15: SMPL_JOINTS.LEFT_WRIST,
  16: SMPL_JOINTS.RIGHT_WRIST,
  0:  SMPL_JOINTS.HEAD,
};

// SMPL kinematic tree: parent[i] = parent joint of joint i
const KINTREE = [
  -1,   // 0 pelvis (root)
  0,    // 1 left_hip
  0,    // 2 right_hip
  0,    // 3 spine1
  1,    // 4 left_knee
  2,    // 5 right_knee
  3,    // 6 spine2
  4,    // 7 left_ankle
  5,    // 8 right_ankle
  6,    // 9 spine3
  7,    // 10 left_foot
  8,    // 11 right_foot
  9,    // 12 neck
  9,    // 13 left_collar
  9,    // 14 right_collar
  12,   // 15 head
  13,   // 16 left_shoulder
  14,   // 17 right_shoulder
  16,   // 18 left_elbow
  17,   // 19 right_elbow
  18,   // 20 left_wrist
  19,   // 21 right_wrist
  20,   // 22 left_hand
  21,   // 23 right_hand
];

// ---- Math helpers ----

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

function norm(v) {
  return Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2);
}

function normalize(v) {
  const n = norm(v) || 1e-8;
  return [v[0]/n, v[1]/n, v[2]/n];
}

/**
 * Rodrigues rotation: rotate vector v by axis-angle aa.
 */
function rodrigues(aa, v) {
  const angle = norm(aa);
  if (angle < 1e-8) return [...v];
  const k = normalize(aa);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const kCrossV = cross(k, v);
  const kDotV = dot(k, v);
  return [
    v[0] * cosA + kCrossV[0] * sinA + k[0] * kDotV * (1 - cosA),
    v[1] * cosA + kCrossV[1] * sinA + k[1] * kDotV * (1 - cosA),
    v[2] * cosA + kCrossV[2] * sinA + k[2] * kDotV * (1 - cosA),
  ];
}

/**
 * Build 4×4 homogeneous transform from axis-angle + translation.
 * Returns flat 16-element row-major array.
 */
function makeTransform(aa, t) {
  const angle = norm(aa);
  let R;
  if (angle < 1e-8) {
    R = [1,0,0, 0,1,0, 0,0,1]; // identity
  } else {
    const k = normalize(aa);
    const c = Math.cos(angle), s = Math.sin(angle), t1 = 1 - c;
    const [kx, ky, kz] = k;
    R = [
      c + kx*kx*t1,    kx*ky*t1 - kz*s, kx*kz*t1 + ky*s,
      ky*kx*t1 + kz*s, c + ky*ky*t1,    ky*kz*t1 - kx*s,
      kz*kx*t1 - ky*s, kz*ky*t1 + kx*s, c + kz*kz*t1,
    ];
  }
  return [
    R[0], R[1], R[2], t[0],
    R[3], R[4], R[5], t[1],
    R[6], R[7], R[8], t[2],
    0,    0,    0,    1,
  ];
}

/** Multiply two 4×4 matrices (row-major). */
function matMul4(A, B) {
  const M = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      for (let k = 0; k < 4; k++) {
        M[r*4+c] += A[r*4+k] * B[k*4+c];
      }
    }
  }
  return M;
}

/** Apply 4×4 matrix to 3D point (homogeneous). */
function applyTransform(M, p) {
  return [
    M[0]*p[0] + M[1]*p[1] + M[2]*p[2] + M[3],
    M[4]*p[0] + M[5]*p[1] + M[6]*p[2] + M[7],
    M[8]*p[0] + M[9]*p[1] + M[10]*p[2] + M[11],
  ];
}

// ---- Forward Kinematics ----

/**
 * Compute world-space joint positions given:
 *  @param {Float32Array} theta  - 72 axis-angle values (24 joints × 3)
 *  @param {Float32Array} jOff   - 24×3 joint offsets from parent (rest-pose skeleton)
 *  @returns {Array}  24 world-space positions [[x,y,z], ...]
 */
function forwardKinematics(theta, jOff) {
  const numJoints = 24;
  const globalTransforms = new Array(numJoints);
  const positions = new Array(numJoints);

  for (let j = 0; j < numJoints; j++) {
    const aa = [theta[j*3], theta[j*3+1], theta[j*3+2]];
    const off = [jOff[j*3], jOff[j*3+1], jOff[j*3+2]];

    const localT = makeTransform(aa, off);

    if (KINTREE[j] === -1) {
      globalTransforms[j] = localT;
    } else {
      globalTransforms[j] = matMul4(globalTransforms[KINTREE[j]], localT);
    }

    positions[j] = [
      globalTransforms[j][3],
      globalTransforms[j][7],
      globalTransforms[j][11],
    ];
  }

  return positions;
}

// ---- IK Solver ----

export class SMPLSolver {
  /**
   * @param {Object} smplModel - loaded SMPL model data (from smpl_model.json)
   */
  constructor(smplModel) {
    this.model = smplModel;
    this.numJoints = 24;

    // Rest-pose joint offsets (parent-relative), derived from J_regressor × v_template
    this.jOff = this._computeRestJointOffsets();

    // Current optimisation state (warm-started across frames)
    this.theta = new Float32Array(72);     // pose parameters
    this.beta  = new Float32Array(10);     // shape parameters (constant for video)

    // Adam optimiser state
    this.m = new Float32Array(72).fill(0); // first moment
    this.v2 = new Float32Array(72).fill(0); // second moment
    this.adamT = 0;
  }

  /**
   * Compute per-joint parent-relative offsets from the SMPL rest mesh.
   */
  _computeRestJointOffsets() {
    const { J_regressor, v_template } = this.model;
    const numVerts = v_template.length; // should be 6890
    const jOff = new Float32Array(this.numJoints * 3);

    // J_regressor: [24, numVerts]  (row-major)
    // joint[j] = J_regressor[j] · v_template
    const worldJoints = [];
    for (let j = 0; j < this.numJoints; j++) {
      let x = 0, y = 0, z = 0;
      for (let v = 0; v < numVerts; v++) {
        const w = J_regressor[j * numVerts + v];
        x += w * v_template[v * 3 + 0];
        y += w * v_template[v * 3 + 1];
        z += w * v_template[v * 3 + 2];
      }
      worldJoints.push([x, y, z]);
    }

    // Convert to parent-relative
    for (let j = 0; j < this.numJoints; j++) {
      if (KINTREE[j] === -1) {
        jOff[j*3]   = worldJoints[j][0];
        jOff[j*3+1] = worldJoints[j][1];
        jOff[j*3+2] = worldJoints[j][2];
      } else {
        const p = KINTREE[j];
        jOff[j*3]   = worldJoints[j][0] - worldJoints[p][0];
        jOff[j*3+1] = worldJoints[j][1] - worldJoints[p][1];
        jOff[j*3+2] = worldJoints[j][2] - worldJoints[p][2];
      }
    }

    return jOff;
  }

  /**
   * Build the SMPL→MediaPipe target mapping for this frame.
   * Returns [[smplJointIdx, targetPos, weight], ...]
   */
  _buildTargets(keypoints3d) {
    const targets = [];
    for (const [mpIdx, smplIdx] of Object.entries(MP_TO_SMPL)) {
      const kp = keypoints3d[Number(mpIdx)];
      if (!kp || kp.confidence < 0.3) continue;
      targets.push([smplIdx, [kp.x, kp.y, kp.z], kp.confidence]);
    }
    return targets;
  }

  /**
   * Compute weighted MSE loss between predicted and target joints.
   */
  _loss(theta, targets) {
    const pred = forwardKinematics(theta, this.jOff);
    let loss = 0;
    for (const [jIdx, target, w] of targets) {
      const p = pred[jIdx];
      loss += w * ((p[0]-target[0])**2 + (p[1]-target[1])**2 + (p[2]-target[2])**2);
    }
    return loss;
  }

  /**
   * Numerical gradient of loss w.r.t. theta.
   */
  _gradient(theta, targets) {
    const eps = 1e-3;
    const grad = new Float32Array(72);
    const baseLoss = this._loss(theta, targets);

    for (let i = 0; i < 72; i++) {
      theta[i] += eps;
      grad[i] = (this._loss(theta, targets) - baseLoss) / eps;
      theta[i] -= eps;
    }
    return grad;
  }

  /**
   * Align the predicted skeleton to match the target scale/translation.
   * Updates this.theta[0:3] (global translation handled separately via
   * the root joint offset).
   */
  _alignRootTranslation(targets) {
    if (targets.length === 0) return;
    const pred = forwardKinematics(this.theta, this.jOff);

    let sumTargetX = 0, sumTargetY = 0, sumTargetZ = 0;
    let sumPredX = 0, sumPredY = 0, sumPredZ = 0;
    let count = 0;

    for (const [jIdx, target] of targets) {
      sumTargetX += target[0];
      sumTargetY += target[1];
      sumTargetZ += target[2];
      sumPredX += pred[jIdx][0];
      sumPredY += pred[jIdx][1];
      sumPredZ += pred[jIdx][2];
      count++;
    }

    if (count === 0) return;
    const dx = sumTargetX/count - sumPredX/count;
    const dy = sumTargetY/count - sumPredY/count;
    const dz = sumTargetZ/count - sumPredZ/count;

    // Store translation in a separate field (not theta)
    this.globalTrans = [dx, dy, dz];
  }

  /**
   * Solve SMPL parameters for one frame.
   * @param {Array} keypoints3d - [{x,y,z,confidence}] (33 MediaPipe 3D joints)
   * @param {Object} opts
   * @returns {{pose: Float32Array, shape: Float32Array, globalTrans: Array}}
   */
  solveFrame(keypoints3d, { iterations = 30, learningRate = 0.05, frameIndex = 0 } = {}) {
    const targets = this._buildTargets(keypoints3d);

    if (targets.length < 3) {
      return {
        frameIndex,
        pose: new Float32Array(this.theta),
        shape: new Float32Array(this.beta),
        globalTrans: this.globalTrans ?? [0, 0, 0],
      };
    }

    // Align root translation first
    this._alignRootTranslation(targets);

    // Shift targets by inverse of global translation so IK works in model space
    const gt = this.globalTrans ?? [0, 0, 0];
    const localTargets = targets.map(([jIdx, pos, w]) => [
      jIdx,
      [pos[0] - gt[0], pos[1] - gt[1], pos[2] - gt[2]],
      w,
    ]);

    // Adam optimisation
    const lr = learningRate;
    const beta1 = 0.9, beta2 = 0.999, eps = 1e-8;

    for (let iter = 0; iter < iterations; iter++) {
      this.adamT++;
      const grad = this._gradient(this.theta, localTargets);

      for (let i = 0; i < 72; i++) {
        this.m[i]  = beta1 * this.m[i]  + (1 - beta1) * grad[i];
        this.v2[i] = beta2 * this.v2[i] + (1 - beta2) * grad[i] * grad[i];
        const mHat = this.m[i]  / (1 - beta1 ** this.adamT);
        const vHat = this.v2[i] / (1 - beta2 ** this.adamT);
        this.theta[i] -= lr * mHat / (Math.sqrt(vHat) + eps);
      }

      // Clamp to reasonable joint angle range (±π)
      for (let i = 0; i < 72; i++) {
        if (this.theta[i] > Math.PI) this.theta[i] = Math.PI;
        if (this.theta[i] < -Math.PI) this.theta[i] = -Math.PI;
      }
    }

    return {
      frameIndex,
      pose: new Float32Array(this.theta),
      shape: new Float32Array(this.beta),
      globalTrans: [...gt],
    };
  }

  /**
   * Solve for all frames.
   * @param {Array} frames3d - [{frameIndex, keypoints3d}]
   * @param {Function} onProgress
   */
  async solveAll(frames3d, onProgress) {
    const results = [];
    for (let i = 0; i < frames3d.length; i++) {
      const { frameIndex, keypoints3d } = frames3d[i];
      const res = this.solveFrame(keypoints3d, { frameIndex });
      results.push(res);
      if (onProgress) onProgress(i + 1, frames3d.length);
      // Yield to UI thread every 5 frames
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
    }
    return results;
  }

  /**
   * Compute the SMPL joint world positions from current theta (for visualisation).
   */
  getJointPositions() {
    return forwardKinematics(this.theta, this.jOff);
  }
}

export { forwardKinematics, KINTREE };
