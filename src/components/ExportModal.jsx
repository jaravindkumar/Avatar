import { useState, useCallback } from 'react';
import { VideoExporter } from '../utils/VideoExporter.js';

export default function ExportModal({ onClose, canvas, renderFrame, totalFrames, fps = 30 }) {
  const [stage, setStage]       = useState('idle'); // idle | exporting | done | error
  const [progress, setProgress] = useState(0);
  const [statusText, setStatus] = useState('');
  const [error, setError]       = useState('');
  const [exportFps, setExportFps] = useState(fps);

  const startExport = useCallback(async () => {
    if (!canvas || !renderFrame || !totalFrames) {
      setError('Rendering not ready. Process a video first.');
      return;
    }

    setStage('exporting');
    setProgress(0);
    setError('');

    try {
      const exporter = new VideoExporter();

      setStatus('Loading FFmpeg encoder...');
      await exporter.load((msg) => {
        if (msg.includes('frame=')) setStatus(msg.slice(0, 60));
      });

      setStatus('Rendering frames...');
      const blob = await exporter.export(
        canvas,
        renderFrame,
        totalFrames,
        exportFps,
        (done, total) => {
          setProgress(Math.round((done / total) * 100));
          setStatus(`Rendering frame ${done} / ${total}`);
        }
      );

      VideoExporter.download(blob, 'avatar_animation.mp4');
      setStage('done');
      setStatus('Export complete!');
    } catch (err) {
      console.error(err);
      setError(err.message ?? String(err));
      setStage('error');
    }
  }, [canvas, renderFrame, totalFrames, exportFps]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-slate-100">Export as MP4</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Settings */}
        {stage === 'idle' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <label className="text-sm text-slate-300">Frame rate</label>
              <select
                value={exportFps}
                onChange={e => setExportFps(Number(e.target.value))}
                className="bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-1.5 border border-slate-600"
              >
                {[15, 24, 30, 60].map(f => (
                  <option key={f} value={f}>{f} fps</option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between text-sm text-slate-400">
              <span>Total frames</span>
              <span>{totalFrames ?? '--'}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-slate-400">
              <span>Estimated duration</span>
              <span>{totalFrames ? (totalFrames / exportFps).toFixed(1) + 's' : '--'}</span>
            </div>
            <button
              onClick={startExport}
              className="mt-2 w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-semibold transition-colors"
            >
              Start Export
            </button>
          </div>
        )}

        {/* Progress */}
        {stage === 'exporting' && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-slate-300 text-center">{statusText}</p>
            <div className="w-full bg-slate-700 rounded-full h-3">
              <div
                className="bg-blue-500 h-3 rounded-full transition-all duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-center text-slate-500">{progress}%</p>
          </div>
        )}

        {/* Done */}
        {stage === 'done' && (
          <div className="flex flex-col items-center gap-4">
            <div className="text-4xl">✅</div>
            <p className="text-slate-200 font-medium">Download started!</p>
            <button
              onClick={onClose}
              className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-xl text-sm transition-colors"
            >
              Close
            </button>
          </div>
        )}

        {/* Error */}
        {(error || stage === 'error') && (
          <div className="mt-4 p-3 bg-red-900/50 border border-red-500 rounded-lg text-red-300 text-sm">
            {error || 'Export failed. Check the console for details.'}
          </div>
        )}
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
