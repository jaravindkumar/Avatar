/**
 * Video exporter: captures rendered Three.js canvas frames and encodes to MP4
 * using FFmpeg.wasm.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const FFMPEG_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

export class VideoExporter {
  constructor() {
    this.ffmpeg = new FFmpeg();
    this.loaded = false;
  }

  async load(onLog) {
    if (this.loaded) return;
    if (onLog) this.ffmpeg.on('log', ({ message }) => onLog(message));

    const coreURL  = await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.js`,   'text/javascript');
    const wasmURL  = await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm');

    await this.ffmpeg.load({ coreURL, wasmURL });
    this.loaded = true;
  }

  /**
   * Export an animation as MP4.
   *
   * @param {HTMLCanvasElement} canvas - The Three.js rendering canvas
   * @param {Function} renderFrame     - (frameIndex: number) => void  – updates the canvas
   * @param {number}   totalFrames
   * @param {number}   fps
   * @param {Function} onProgress      - (done, total) => void
   * @returns {Blob} MP4 blob
   */
  async export(canvas, renderFrame, totalFrames, fps = 30, onProgress) {
    await this.load();

    const { ffmpeg } = this;
    const framePad = String(totalFrames).length;

    // Render and capture each frame
    for (let i = 0; i < totalFrames; i++) {
      renderFrame(i);

      // Grab canvas as PNG
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const data = await fetchFile(blob);
      const filename = `frame${String(i).padStart(framePad, '0')}.png`;
      await ffmpeg.writeFile(filename, data);

      if (onProgress) onProgress(i + 1, totalFrames);
    }

    // Encode to MP4 with h264
    await ffmpeg.exec([
      '-framerate', String(fps),
      '-i', `frame%0${framePad}d.png`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-preset', 'fast',
      'output.mp4',
    ]);

    const data = await ffmpeg.readFile('output.mp4');
    const mp4Blob = new Blob([data.buffer], { type: 'video/mp4' });

    // Cleanup
    for (let i = 0; i < totalFrames; i++) {
      const filename = `frame${String(i).padStart(framePad, '0')}.png`;
      await ffmpeg.deleteFile(filename).catch(() => {});
    }
    await ffmpeg.deleteFile('output.mp4').catch(() => {});

    return mp4Blob;
  }

  /**
   * Trigger browser download of a Blob.
   */
  static download(blob, filename = 'avatar_animation.mp4') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
