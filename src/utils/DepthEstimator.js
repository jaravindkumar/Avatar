/**
 * Heuristic monocular depth estimator.
 * Converts 2D MediaPipe keypoints → approximate 3D joint positions.
 *
 * Assumptions:
 *  - Frontal-facing camera (0-30° rotation)
 *  - Person roughly centred in frame
 *  - Camera at roughly eye level (~1.5 m)
 */

const FOCAL_LENGTH = 500;          // pixels (approximate)
const CAMERA_DISTANCE_OFFSET = 0.5; // metres added to estimated distance
const DEPTH_SCALE = 0.15;          // scale of per-joint depth variation (m)

// MediaPipe pose landmark indices
const MP = {
  NOSE: 0,
  LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20,
  LEFT_THUMB: 21, RIGHT_THUMB: 22,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

/**
 * Per-landmark depth offsets relative to body centre.
 * Positive = closer to camera, negative = further away.
 */
const DEPTH_OFFSETS = new Array(33).fill(0);
// Head slightly forward
DEPTH_OFFSETS[MP.NOSE] = 0.12;
DEPTH_OFFSETS[MP.LEFT_EYE_INNER] = 0.10;
DEPTH_OFFSETS[MP.RIGHT_EYE_INNER] = 0.10;
DEPTH_OFFSETS[MP.LEFT_EYE] = 0.10;
DEPTH_OFFSETS[MP.RIGHT_EYE] = 0.10;
DEPTH_OFFSETS[MP.LEFT_EAR] = 0.0;
DEPTH_OFFSETS[MP.RIGHT_EAR] = 0.0;
DEPTH_OFFSETS[MP.MOUTH_LEFT] = 0.10;
DEPTH_OFFSETS[MP.MOUTH_RIGHT] = 0.10;
// Shoulders roughly coplanar with torso
DEPTH_OFFSETS[MP.LEFT_SHOULDER] = 0.05;
DEPTH_OFFSETS[MP.RIGHT_SHOULDER] = 0.05;
// Elbows / wrists slightly forward when arms hang
DEPTH_OFFSETS[MP.LEFT_ELBOW] = 0.03;
DEPTH_OFFSETS[MP.RIGHT_ELBOW] = 0.03;
DEPTH_OFFSETS[MP.LEFT_WRIST] = 0.02;
DEPTH_OFFSETS[MP.RIGHT_WRIST] = 0.02;
// Hips at body plane
DEPTH_OFFSETS[MP.LEFT_HIP] = 0.0;
DEPTH_OFFSETS[MP.RIGHT_HIP] = 0.0;
// Knees slightly forward
DEPTH_OFFSETS[MP.LEFT_KNEE] = 0.04;
DEPTH_OFFSETS[MP.RIGHT_KNEE] = 0.04;
// Ankles and feet at floor level
DEPTH_OFFSETS[MP.LEFT_ANKLE] = 0.0;
DEPTH_OFFSETS[MP.RIGHT_ANKLE] = 0.0;

/**
 * Estimate the camera distance from the apparent body height in pixels.
 * @param {Array} keypoints2d - 33 MediaPipe keypoints [{x, y, confidence}]
 * @param {number} frameHeight - height of the video frame in pixels
 * @returns {number} estimated distance in metres
 */
function estimateCameraDistance(keypoints2d, frameHeight) {
  const nose = keypoints2d[MP.NOSE];
  const leftAnkle = keypoints2d[MP.LEFT_ANKLE];
  const rightAnkle = keypoints2d[MP.RIGHT_ANKLE];

  const headY = nose?.confidence > 0.3 ? nose.y : null;
  const feetY = (leftAnkle?.confidence > 0.3 && rightAnkle?.confidence > 0.3)
    ? (leftAnkle.y + rightAnkle.y) / 2
    : null;

  const AVERAGE_BODY_HEIGHT_M = 1.7;

  if (headY !== null && feetY !== null) {
    const bboxHeightPx = Math.abs(feetY - headY) * frameHeight;
    if (bboxHeightPx > 10) {
      return (FOCAL_LENGTH * AVERAGE_BODY_HEIGHT_M) / bboxHeightPx + CAMERA_DISTANCE_OFFSET;
    }
  }

  // Fallback: shoulder width heuristic
  const ls = keypoints2d[MP.LEFT_SHOULDER];
  const rs = keypoints2d[MP.RIGHT_SHOULDER];
  if (ls?.confidence > 0.3 && rs?.confidence > 0.3) {
    const shoulderWidthPx = Math.abs(ls.x - rs.x) * frameHeight;
    const AVERAGE_SHOULDER_WIDTH_M = 0.45;
    if (shoulderWidthPx > 5) {
      return (FOCAL_LENGTH * AVERAGE_SHOULDER_WIDTH_M) / shoulderWidthPx + CAMERA_DISTANCE_OFFSET;
    }
  }

  return 3.0; // default 3 m away
}

/**
 * Convert a single frame of 2D keypoints to 3D.
 * @param {Array} keypoints2d - [{x, y, z?, confidence}] (x,y normalised 0-1)
 * @param {{width: number, height: number}} videoMeta
 * @param {number} frameIndex
 * @returns {{frameIndex, keypoints3d: [{x,y,z,confidence}]}}
 */
export function estimateDepth(keypoints2d, videoMeta, frameIndex) {
  const { width, height } = videoMeta;
  const cx = 0.5; // normalised principal point
  const cy = 0.5;
  const fx = FOCAL_LENGTH / height; // normalised focal length

  const dist = estimateCameraDistance(keypoints2d, height);

  const keypoints3d = keypoints2d.map((kp, i) => {
    if (!kp || kp.confidence < 0.1) {
      return { x: 0, y: 0, z: dist, confidence: 0 };
    }

    const xNorm = (kp.x - cx) / fx;
    const yNorm = -(kp.y - cy) / fx; // flip Y so up is positive

    const depthOffset = DEPTH_OFFSETS[i] ?? 0;
    const z = dist + depthOffset * DEPTH_SCALE;

    return {
      x: xNorm * z,
      y: yNorm * z,
      z,
      confidence: kp.confidence,
    };
  });

  return { frameIndex, keypoints3d };
}

/**
 * Process a full array of smoothed keypoint frames.
 * @param {Array} smoothedFrames - [{frameIndex, keypoints2d}]
 * @param {{width, height}} videoMeta
 * @returns {Array} [{frameIndex, keypoints3d}]
 */
export function estimateDepthBatch(smoothedFrames, videoMeta) {
  return smoothedFrames.map(({ frameIndex, keypoints2d }) =>
    estimateDepth(keypoints2d, videoMeta, frameIndex)
  );
}
