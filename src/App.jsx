import { useState, useCallback, useRef, useEffect } from 'react';
import VideoUploader from './components/VideoUploader.jsx';
import AvatarViewer  from './components/AvatarViewer.jsx';
import PlaybackController from './components/PlaybackController.jsx';
import ExportModal   from './components/ExportModal.jsx';

import { PoseExtractor }      from './utils/PoseExtractor.js';
import { KalmanSmoother }     from './utils/KalmanSmoother.js';
import { estimateDepthBatch } from './utils/DepthEstimator.js';
import { SMPLSolver }         from './utils/SMPLSolver.js';
import './App.css';

const STAGES = {
  UPLOAD:  'upload',
  POSE:    'pose',
  DEPTH:   'depth',
  SMPL:    'smpl',
  VIEWER:  'viewer',
};

export default function App() {
  const [stage, setStage]             = useState(STAGES.UPLOAD);
  const [videoMeta, setVideoMeta]     = useState(null);
  const [frames, setFrames]           = useState([]);
  const [frames3d, setFrames3d]       = useState([]);
  const [smplParams, setSmplParams]   = useState([]);
  const [smplModel, setSmplModel]     = useState(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [displayMode, setDisplayMode] = useState('solid');
  const [viewMode, setViewMode]       = useState('avatar');
  const [showExport, setShowExport]   = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ step: '', done: 0, total: 0 });
  const [error, setError]             = useState('');

  const renderHandleRef = useRef(null);

  const handleFramesExtracted = useCallback(async (extractedFrames, meta) => {
    setFrames(extractedFrames);
    setVideoMeta(meta);
    setStage(STAGES.POSE);
    setError('');

    // Step 1: Pose extraction
    setProcessingProgress({ step: 'Running MediaPipe pose detection...', done: 0, total: extractedFrames.length });
    const extractor = new PoseExtractor(0.5);
    let poseResults;
    try {
      poseResults = await extractor.extractAll(extractedFrames, (done, total) => {
        setProcessingProgress({ step: 'Running MediaPipe pose detection...', done, total });
      });
      extractor.dispose();
    } catch (err) {
      setError(`Pose extraction failed: ${err.message}`);
      setStage(STAGES.UPLOAD);
      return;
    }

    // Step 2: Kalman smoothing
    setProcessingProgress({ step: 'Smoothing keypoints...', done: 0, total: poseResults.length });
    const smoother = new KalmanSmoother(33);
    const smoothedFrames = poseResults.map(({ frameIndex, keypoints2d }, i) => {
      if (i % 20 === 0) setProcessingProgress({ step: 'Smoothing keypoints...', done: i, total: poseResults.length });
      return { frameIndex, keypoints2d: smoother.smooth(keypoints2d) };
    });

    // Step 3: Depth estimation
    setStage(STAGES.DEPTH);
    setProcessingProgress({ step: 'Estimating depth...', done: 0, total: smoothedFrames.length });
    const depth3d = estimateDepthBatch(smoothedFrames, meta);
    setFrames3d(depth3d);
    setProcessingProgress({ step: 'Estimating depth...', done: depth3d.length, total: depth3d.length });

    // Step 4: Load SMPL model (optional – served from /smpl_model.json)
    let model = null;
    try {
      const resp = await fetch('/smpl_model.json');
      if (resp.ok) {
        const raw = await resp.json();
        model = flattenSmplModel(raw);
        setSmplModel(model);
      }
    } catch {
      // Skeleton-only mode if model unavailable
    }

    // Step 5: SMPL IK solving
    if (model) {
      setStage(STAGES.SMPL);
      setProcessingProgress({ step: 'Solving SMPL pose parameters...', done: 0, total: depth3d.length });
      const solver = new SMPLSolver(model);
      const params = await solver.solveAll(depth3d, (done, total) => {
        setProcessingProgress({ step: 'Solving SMPL pose parameters...', done, total });
      });
      setSmplParams(params);
    }

    setStage(STAGES.VIEWER);
    setCurrentFrame(0);
  }, []);

  const isProcessing = [STAGES.POSE, STAGES.DEPTH, STAGES.SMPL].includes(stage);
  const totalFrames  = smplParams.length || frames3d.length || frames.length;
  const currentKp3d  = frames3d[currentFrame]?.keypoints3d ?? null;

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <span className="app-title">Avatar3D</span>
          <span className="app-subtitle">Video → 3D Avatar Pipeline</span>
        </div>
        {stage === STAGES.VIEWER && (
          <div className="header-actions">
            <label className="btn-secondary text-xs cursor-pointer">
              Load SMPL Model
              <input
                type="file"
                accept=".json"
                className="hidden-input"
                onChange={async (e) => {
                  const f = e.target.files[0];
                  if (!f) return;
                  try {
                    const text = await f.text();
                    setSmplModel(flattenSmplModel(JSON.parse(text)));
                  } catch (err) {
                    setError(`Failed to load SMPL model: ${err.message}`);
                  }
                }}
              />
            </label>

            <div className="toggle-group">
              {['avatar', 'skeleton', 'sidebyside'].map(m => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`toggle-btn ${viewMode === m ? 'active' : ''}`}
                >
                  {m === 'sidebyside' ? 'Side-by-Side' : m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>

            <button
              onClick={() => setDisplayMode(dm => dm === 'solid' ? 'wireframe' : 'solid')}
              className="btn-secondary"
            >
              {displayMode === 'solid' ? 'Wireframe' : 'Solid'}
            </button>

            <button
              onClick={() => setShowExport(true)}
              className="btn-primary"
            >
              Export MP4
            </button>
          </div>
        )}
      </header>

      {/* Main */}
      <main className="app-main">
        {stage === STAGES.UPLOAD && (
          <div className="upload-view">
            <div className="hero-text">
              <h1>Turn your workout video into a 3D avatar</h1>
              <p>
                Upload MP4, MOV, or WebM. Pose is extracted with MediaPipe, depth is estimated
                heuristically, and an SMPL body model is animated — entirely in your browser.
              </p>
            </div>
            <VideoUploader
              onFramesExtracted={handleFramesExtracted}
              onVideoMeta={setVideoMeta}
            />
            {error && <div className="error-msg">{error}</div>}
          </div>
        )}

        {isProcessing && (
          <div className="processing-view">
            <PipelineProgress stage={stage} progress={processingProgress} videoMeta={videoMeta} />
          </div>
        )}

        {stage === STAGES.VIEWER && (
          <div className="viewer-shell">
            {viewMode === 'sidebyside' ? (
              <div className="sidebyside-layout">
                <div className="sidebyside-pane">
                  <OriginalFrameView canvas={frames[currentFrame]?.canvas} label="Original" />
                </div>
                <div className="sidebyside-pane">
                  <AvatarViewer
                    smplModel={smplModel}
                    frameParams={smplParams}
                    currentFrame={currentFrame}
                    displayMode={displayMode}
                    viewMode="avatar"
                    keypoints3d={currentKp3d}
                    onReady={(h) => { renderHandleRef.current = h; }}
                  />
                </div>
              </div>
            ) : (
              <div className="viewer-pane">
                <AvatarViewer
                  smplModel={smplModel}
                  frameParams={smplParams}
                  currentFrame={currentFrame}
                  displayMode={displayMode}
                  viewMode={viewMode}
                  keypoints3d={currentKp3d}
                  onReady={(h) => { renderHandleRef.current = h; }}
                />
              </div>
            )}

            <div className="playback-bar">
              <PlaybackController
                totalFrames={totalFrames}
                fps={videoMeta?.fps ?? 30}
                currentFrame={currentFrame}
                onFrameChange={setCurrentFrame}
              />
            </div>
          </div>
        )}
      </main>

      {showExport && (
        <ExportModal
          onClose={() => setShowExport(false)}
          canvas={renderHandleRef.current?.canvas}
          renderFrame={renderHandleRef.current?.renderFrame}
          totalFrames={totalFrames}
          fps={videoMeta?.fps ?? 30}
        />
      )}
    </div>
  );
}

// ---- Sub-components ----

function PipelineProgress({ stage, progress, videoMeta }) {
  const steps = [
    { id: 'pose',  label: 'Pose Detection',   icon: '🦴' },
    { id: 'depth', label: 'Depth Estimation', icon: '📐' },
    { id: 'smpl',  label: 'SMPL IK Solving',  icon: '🤸' },
  ];
  const currentIdx = stage === 'pose' ? 0 : stage === 'depth' ? 1 : 2;
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="pipeline-progress">
      {videoMeta && (
        <p className="video-dim-label">
          Processing {videoMeta.width}×{videoMeta.height} video
        </p>
      )}
      <div className="steps-row">
        {steps.map((s, i) => (
          <div key={s.id} className="step-item">
            <div className={`step-badge ${i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending'}`}>
              <span>{s.icon}</span>
              <span>{s.label}</span>
            </div>
            {i < steps.length - 1 && <span className="step-arrow">→</span>}
          </div>
        ))}
      </div>
      <div className="progress-block">
        <div className="progress-labels">
          <span>{progress.step}</span>
          <span>{pct}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        {progress.total > 0 && (
          <p className="progress-count">{progress.done} / {progress.total} frames</p>
        )}
      </div>
    </div>
  );
}

function OriginalFrameView({ canvas, label }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!canvas || !ref.current) return;
    const ctx = ref.current.getContext('2d');
    ref.current.width  = canvas.width;
    ref.current.height = canvas.height;
    ctx.drawImage(canvas, 0, 0);
  }, [canvas]);

  return (
    <div className="original-frame-view">
      <canvas ref={ref} className="original-canvas" />
      <span className="frame-label">{label}</span>
    </div>
  );
}

// ---- Helpers ----

function flattenSmplModel(raw) {
  const toFlat = (arr) => {
    if (!arr) return null;
    if (Array.isArray(arr[0])) return new Float32Array(arr.flat(Infinity));
    return new Float32Array(arr);
  };
  return {
    v_template:    toFlat(raw.v_template),
    J_regressor:   toFlat(raw.J_regressor),
    weights:       toFlat(raw.weights),
    posedirs:      toFlat(raw.posedirs),
    shapedirs:     toFlat(raw.shapedirs),
    kintree_table: raw.kintree_table,
    faces: raw.faces
      ? new Uint32Array(Array.isArray(raw.faces[0]) ? raw.faces.flat() : raw.faces)
      : null,
    mean_pose:  toFlat(raw.mean_pose)  ?? new Float32Array(72),
    mean_shape: toFlat(raw.mean_shape) ?? new Float32Array(10),
  };
}
