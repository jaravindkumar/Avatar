import { useEffect, useRef, useState, useCallback } from 'react';

export default function PlaybackController({
  totalFrames = 0,
  fps = 30,
  currentFrame,
  onFrameChange,
}) {
  const [isPlaying, setIsPlaying]   = useState(false);
  const [speed, setSpeed]           = useState(1.0);
  const intervalRef                 = useRef(null);
  const frameRef                    = useRef(currentFrame ?? 0);

  // Keep frameRef in sync with controlled value
  useEffect(() => {
    if (currentFrame !== undefined) frameRef.current = currentFrame;
  }, [currentFrame]);

  // Playback timer
  useEffect(() => {
    if (isPlaying && totalFrames > 0) {
      const delay = 1000 / (fps * speed);
      intervalRef.current = setInterval(() => {
        frameRef.current = (frameRef.current + 1) % totalFrames;
        onFrameChange?.(frameRef.current);
      }, delay);
    }
    return () => clearInterval(intervalRef.current);
  }, [isPlaying, fps, speed, totalFrames, onFrameChange]);

  const togglePlay = useCallback(() => setIsPlaying(p => !p), []);

  const seek = useCallback((e) => {
    const idx = parseInt(e.target.value);
    frameRef.current = idx;
    onFrameChange?.(idx);
  }, [onFrameChange]);

  const stepBack = useCallback(() => {
    const idx = Math.max(0, (frameRef.current ?? 0) - 1);
    frameRef.current = idx;
    onFrameChange?.(idx);
  }, [onFrameChange]);

  const stepForward = useCallback(() => {
    const idx = Math.min(totalFrames - 1, (frameRef.current ?? 0) + 1);
    frameRef.current = idx;
    onFrameChange?.(idx);
  }, [onFrameChange, totalFrames]);

  const displayFrame = currentFrame ?? frameRef.current ?? 0;
  const currentTime  = displayFrame / fps;
  const totalTime    = totalFrames / fps;

  return (
    <div className="w-full flex flex-col gap-3 bg-slate-800 rounded-xl p-4">
      {/* Seek bar */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-400 w-12 text-right">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, totalFrames - 1)}
          value={displayFrame}
          onChange={seek}
          disabled={totalFrames === 0}
          className="flex-1 h-2 accent-blue-500 cursor-pointer"
        />
        <span className="text-xs text-slate-400 w-12">{formatTime(totalTime)}</span>
      </div>

      {/* Controls row */}
      <div className="flex items-center justify-between gap-4">
        {/* Transport */}
        <div className="flex items-center gap-2">
          <button
            onClick={stepBack}
            disabled={totalFrames === 0}
            className="p-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 transition-colors"
            title="Previous frame"
          >
            <SkipBackIcon />
          </button>
          <button
            onClick={togglePlay}
            disabled={totalFrames === 0}
            className="p-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 transition-colors"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            onClick={stepForward}
            disabled={totalFrames === 0}
            className="p-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 transition-colors"
            title="Next frame"
          >
            <SkipForwardIcon />
          </button>
        </div>

        {/* Frame counter */}
        <span className="text-xs text-slate-400 tabular-nums">
          Frame {displayFrame + 1} / {totalFrames || '--'}
        </span>

        {/* Speed control */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Speed</span>
          <select
            value={speed}
            onChange={e => setSpeed(parseFloat(e.target.value))}
            className="bg-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1 border border-slate-600"
          >
            {[0.25, 0.5, 1.0, 1.5, 2.0].map(s => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function formatTime(seconds) {
  if (!isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---- SVG Icons ----
function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5,3 19,12 5,21" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}
function SkipBackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="19,20 9,12 19,4" />
      <line x1="5" y1="4" x2="5" y2="20" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function SkipForwardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5,4 15,12 5,20" />
      <line x1="19" y1="4" x2="19" y2="20" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
