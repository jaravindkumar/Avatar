/**
 * MediaPipe Pose extractor.
 * Loads the PoseLandmarker model and runs per-frame inference.
 *
 * Uses @mediapipe/tasks-vision (v0.10+).
 */

import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export class PoseExtractor {
  constructor(confidenceThreshold = 0.5) {
    this.confidenceThreshold = confidenceThreshold;
    this.landmarker = null;
    this.loadPromise = null;
  }

  /** Lazy-initialise once, reuse thereafter. */
  async load() {
    if (this.landmarker) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: this.confidenceThreshold,
        minPosePresenceConfidence: this.confidenceThreshold,
        minTrackingConfidence: this.confidenceThreshold,
      });
    })();

    return this.loadPromise;
  }

  /**
   * Run inference on a single ImageBitmap / HTMLCanvasElement / HTMLVideoElement.
   * @param {ImageBitmap|HTMLCanvasElement} image
   * @param {number} frameIndex
   * @returns {{frameIndex, keypoints2d, detectionTime}}
   */
  async extractFrame(image, frameIndex) {
    await this.load();

    const t0 = performance.now();
    const result = this.landmarker.detect(image);
    const detectionTime = performance.now() - t0;

    if (!result.landmarks || result.landmarks.length === 0) {
      // Return zero-confidence keypoints so the pipeline still gets 33 points
      const keypoints2d = Array.from({ length: 33 }, () => ({
        x: 0, y: 0, z: 0, confidence: 0,
      }));
      return { frameIndex, keypoints2d, detectionTime };
    }

    const landmarks = result.landmarks[0]; // first (only) pose
    const keypoints2d = landmarks.map(lm => ({
      x: lm.x,          // normalised 0-1
      y: lm.y,          // normalised 0-1
      z: lm.z ?? 0,     // relative depth hint from MediaPipe
      confidence: lm.visibility ?? 0,
    }));

    return { frameIndex, keypoints2d, detectionTime };
  }

  /**
   * Run inference on all frames sequentially, calling onProgress after each.
   * @param {Array} frames - [{frameIndex, canvas}]
   * @param {Function} onProgress - (done, total) => void
   * @returns {Array} [{frameIndex, keypoints2d, detectionTime}]
   */
  async extractAll(frames, onProgress) {
    await this.load();

    const results = [];
    for (let i = 0; i < frames.length; i++) {
      const { frameIndex, canvas } = frames[i];
      const res = await this.extractFrame(canvas, frameIndex);
      results.push(res);
      if (onProgress) onProgress(i + 1, frames.length);
    }
    return results;
  }

  dispose() {
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
  }
}
