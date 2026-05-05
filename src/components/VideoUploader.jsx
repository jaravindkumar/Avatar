import { useCallback, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const FFMPEG_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
const ACCEPTED = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'];
const TARGET_FPS = 30;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function VideoUploader({ onFramesExtracted, onVideoMeta }) {
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile]             = useState(null);
  const [stage, setStage]           = useState('idle'); // idle | ready | loading | extracting | done | error
  const [progress, setProgress]     = useState(0);
  const [statusText, setStatusText] = useState('');
  const [error, setError]           = useState('');
  const inputRef  = useRef(null);
  const ffmpegRef = useRef(null);

  const loadFile = useCallback((f) => {
    if (!ACCEPTED.includes(f.type) && !f.name.match(/\.(mp4|mov|webm|avi)$/i)) {
      setError('Unsupported format. Please upload MP4, MOV, WebM, or AVI.');
      return;
    }
    setFile(f);
    setStage('ready');
    setError('');
    setProgress(0);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  }, [loadFile]);

  const onInputChange = useCallback((e) => {
    const f = e.target.files[0];
    if (f) loadFile(f);
  }, [loadFile]);

  const extractFrames = useCallback(async () => {
    if (!file) return;
    setStage('loading');
    setProgress(0);
    setError('');

    try {
      // Load FFmpeg
      setStatusText('Loading FFmpeg...');
      if (!ffmpegRef.current) {
        const ff = new FFmpeg();
        ff.on('log', ({ message }) => {
          // Parse progress from FFmpeg output
          const m = message.match(/frame=\s*(\d+)/);
          if (m) {
            const done = parseInt(m[1]);
            if (totalFramesRef.current > 0) {
              setProgress(Math.min(100, Math.round((done / totalFramesRef.current) * 100)));
            }
          }
        });
        const coreURL = await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.js`,   'text/javascript');
        const wasmURL = await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm');
        await ff.load({ coreURL, wasmURL });
        ffmpegRef.current = ff;
      }
      const ff = ffmpegRef.current;

      // Get video metadata via a hidden video element
      setStatusText('Reading video metadata...');
      const videoMeta = await getVideoMetadata(file);
      onVideoMeta?.(videoMeta);

      const totalFramesRef = { current: Math.round(videoMeta.duration * TARGET_FPS) };
      const totalFrames = totalFramesRef.current;

      setStage('extracting');
      setStatusText(`Extracting ${totalFrames} frames at ${TARGET_FPS} fps...`);

      // Write video to FFmpeg virtual FS
      await ff.writeFile('input.video', await fetchFile(file));

      // Extract frames as PNG
      await ff.exec([
        '-i', 'input.video',
        '-vf', `fps=${TARGET_FPS}`,
        '-q:v', '2',
        'frame%06d.png',
      ]);

      // Read all extracted frames
      setStatusText('Reading frames...');
      const frames = [];
      for (let i = 1; i <= totalFrames; i++) {
        const name = `frame${String(i).padStart(6, '0')}.png`;
        let data;
        try {
          data = await ff.readFile(name);
        } catch {
          break; // no more frames
        }

        const blob   = new Blob([data.buffer], { type: 'image/png' });
        const url    = URL.createObjectURL(blob);
        const canvas = await loadImageToCanvas(url, videoMeta.width, videoMeta.height);
        URL.revokeObjectURL(url);

        frames.push({ frameIndex: i - 1, canvas, timestamp: (i - 1) / TARGET_FPS });

        if (i % 10 === 0) {
          setProgress(Math.round((i / totalFrames) * 100));
          await new Promise(r => setTimeout(r, 0)); // yield to UI
        }

        // Cleanup frame from FS
        await ff.deleteFile(name).catch(() => {});
      }

      await ff.deleteFile('input.video').catch(() => {});

      setStage('done');
      setProgress(100);
      setStatusText(`Extracted ${frames.length} frames`);
      onFramesExtracted?.(frames, { ...videoMeta, totalFrames: frames.length, fps: TARGET_FPS });

    } catch (err) {
      console.error(err);
      setError(err.message ?? String(err));
      setStage('error');
    }
  }, [file, onFramesExtracted, onVideoMeta]);

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Drop Zone */}
      {stage === 'idle' || stage === 'ready' ? (
        <div
          className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors
            ${isDragging ? 'border-blue-400 bg-blue-950' : 'border-slate-600 bg-slate-800 hover:border-blue-500'}
          `}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
            className="hidden"
            onChange={onInputChange}
          />
          <div className="flex flex-col items-center gap-3 text-slate-300">
            <VideoIcon />
            <p className="text-lg font-semibold">
              {isDragging ? 'Drop to upload' : 'Drag & drop your workout video'}
            </p>
            <p className="text-sm text-slate-500">MP4, MOV, WebM · up to ~500 MB</p>
          </div>
        </div>
      ) : null}

      {/* File Info */}
      {file && (stage === 'ready' || stage === 'loading' || stage === 'extracting' || stage === 'done' || stage === 'error') && (
        <div className="mt-4 p-4 bg-slate-800 rounded-xl flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🎬</span>
            <div>
              <p className="text-sm font-medium text-slate-200 truncate max-w-xs">{file.name}</p>
              <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
            </div>
          </div>
          {stage === 'ready' && (
            <button
              onClick={extractFrames}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-semibold text-sm transition-colors"
            >
              Process Video
            </button>
          )}
          {stage === 'done' && (
            <span className="text-green-400 text-sm font-medium">Done</span>
          )}
        </div>
      )}

      {/* Progress */}
      {(stage === 'loading' || stage === 'extracting') && (
        <div className="mt-4">
          <div className="flex justify-between text-xs text-slate-400 mb-1">
            <span>{statusText}</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-3 p-3 bg-red-900/50 border border-red-500 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}
    </div>
  );
}

// ---- Helpers ----

async function getVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        fps: 30, // assume 30fps
      });
      URL.revokeObjectURL(video.src);
    };
    video.onerror = reject;
    video.src = URL.createObjectURL(file);
  });
}

async function loadImageToCanvas(url, width, height) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = width  || img.naturalWidth;
      canvas.height = height || img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = url;
  });
}

function VideoIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="m16 21-4-4-4 4" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}
