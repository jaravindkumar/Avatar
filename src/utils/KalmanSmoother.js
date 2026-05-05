/**
 * Per-keypoint 1D Kalman filter.
 * State vector: [position, velocity]
 * Reduces jitter in 2D pose keypoints across frames.
 */

const PROCESS_NOISE = 0.01;
const MEASUREMENT_NOISE = 0.5;

class KalmanFilter1D {
  constructor() {
    // State: [x, v]
    this.x = 0;
    this.v = 0;
    // Covariance matrix (2x2, flattened): [p00, p01, p10, p11]
    this.p = [1, 0, 0, 1];
    this.initialized = false;
  }

  update(measurement) {
    if (!this.initialized) {
      this.x = measurement;
      this.v = 0;
      this.initialized = true;
      return measurement;
    }

    const dt = 1;
    // Predict
    const xPred = this.x + this.v * dt;
    const vPred = this.v;

    // Predicted covariance P' = F*P*F^T + Q
    // F = [[1,dt],[0,1]]
    const p00 = this.p[0] + dt * (this.p[2] + this.p[1]) + dt * dt * this.p[3] + PROCESS_NOISE;
    const p01 = this.p[1] + dt * this.p[3];
    const p10 = this.p[2] + dt * this.p[3];
    const p11 = this.p[3] + PROCESS_NOISE;

    // Kalman gain K = P' * H^T * (H * P' * H^T + R)^-1
    // H = [1, 0] (observe position only)
    const S = p00 + MEASUREMENT_NOISE;
    const k0 = p00 / S;
    const k1 = p10 / S;

    // Update
    const innovation = measurement - xPred;
    this.x = xPred + k0 * innovation;
    this.v = vPred + k1 * innovation;

    this.p[0] = p00 * (1 - k0);
    this.p[1] = p01 - k0 * p01;
    this.p[2] = p10 - k1 * p00;
    this.p[3] = p11 - k1 * p01;

    return this.x;
  }

  reset() {
    this.initialized = false;
    this.p = [1, 0, 0, 1];
  }
}

export class KalmanSmoother {
  constructor(numKeypoints = 33) {
    this.numKeypoints = numKeypoints;
    // Two filters per keypoint: x and y
    this.filtersX = Array.from({ length: numKeypoints }, () => new KalmanFilter1D());
    this.filtersY = Array.from({ length: numKeypoints }, () => new KalmanFilter1D());
    this.filtersZ = Array.from({ length: numKeypoints }, () => new KalmanFilter1D());
  }

  /**
   * Smooth a single frame of keypoints.
   * @param {Array} keypoints - [{x, y, z, confidence}, ...]
   * @returns {Array} smoothed keypoints
   */
  smooth(keypoints) {
    return keypoints.map((kp, i) => {
      if (i >= this.numKeypoints) return kp;
      const sx = this.filtersX[i].update(kp.x);
      const sy = this.filtersY[i].update(kp.y);
      const sz = this.filtersZ[i].update(kp.z ?? 0);
      return { ...kp, x: sx, y: sy, z: sz };
    });
  }

  reset() {
    this.filtersX.forEach(f => f.reset());
    this.filtersY.forEach(f => f.reset());
    this.filtersZ.forEach(f => f.reset());
  }
}
