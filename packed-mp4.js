/* Offline color + matte MP4 export. No PNG sequence, uploads or realtime recording. */
(function (root) {
  'use strict';
  const PANEL = Object.freeze({ width: 1136, height: 1424 });
  const RECT = Object.freeze({ x: 62, y: 307, width: 1014, height: 1052 });
  const SCALE = 0.90;
  let library;
  function loadLibrary() {
    if (root.Mediabunny) return Promise.resolve(root.Mediabunny);
    return library ||= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/mediabunny-1.65.2.min.js';
      script.onload = () => resolve(root.Mediabunny);
      script.onerror = () => { library = null; script.remove(); reject(new Error('MP4 编码库未能加载，请保留 vendor 文件夹并重试。')); };
      document.head.appendChild(script);
    });
  }
  const abortCheck = signal => { if (signal?.aborted) throw new DOMException('已取消导出', 'AbortError'); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  function makeSchedule(times, start, end) {
    if (!(end > start) || start < 0 || !Number.isFinite(end)) throw new Error('选段时间无效。');
    let points = [start];
    if (times?.length) points.push(...times.filter(t => t > start + 1e-7 && t < end - 1e-7));
    else for (let t = start + 1 / 30; t < end - 1e-7; t += 1 / 30) points.push(t);
    points = [...new Set(points)].sort((a, b) => a - b);
    return points.map((time, index) => {
      const next = points[index + 1] ?? end;
      const timestamp = Math.round((time - start) * 1e6) / 1e6;
      const finish = Math.round((next - start) * 1e6) / 1e6;
      return { sourceTime: time + Math.min(0.0001, (next - time) / 4), timestamp, duration: finish - timestamp };
    }).filter(frame => frame.duration > 0);
  }

  async function exportVideo({ file, params, frameTimes, start, end, signal, onProgress = () => {}, onFirstFrame, onCutoutFrame }) {
    if (!file) throw new Error('请先载入视频。');
    if (!root.VideoEncoder || !root.VideoDecoder) throw new Error('当前浏览器不支持视频直接编码，请使用新版 Chrome 或 Edge。');
    const began = performance.now();
    const B = await loadLibrary(); abortCheck(signal);
    const schedule = makeSchedule(frameTimes, start, end);
    const snapshot = Keylight.mergeParams(JSON.parse(JSON.stringify(params)));
    const quality = new B.Quality({ bitrate: 14000000, bitrateMode: 'variable' });
    onProgress({ phase: '准备编码器', value: 0.01, frames: schedule.length });
    const encoderConfig = { codec: 'avc', quality, latencyMode: 'quality', keyFrameInterval: 2, hardwareAcceleration: 'no-preference' };
    if (!await B.canEncodeVideo('avc', { width: PANEL.width * 2, height: PANEL.height, quality, hardwareAcceleration: 'no-preference' })) {
      throw new Error('此浏览器无法编码 2272×1424 的 H.264 MP4，请换用 Chrome 或 Edge 重试。');
    }
    let input, output, analyzer, keyer, completed = false;
    try {
      input = new B.Input({ source: new B.BlobSource(file), formats: B.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !await track.canDecode()) throw new Error('无法解码此视频，请换用 H.264 MP4。');
      const sourceWidth = await track.getDisplayWidth(), sourceHeight = await track.getDisplayHeight();
      const probeWidth = Math.min(208, sourceWidth);
      const probeHeight = Math.max(1, Math.round(sourceHeight * probeWidth / sourceWidth));
      const ratio = probeWidth / sourceWidth;
      const analysisParams = { ...snapshot, choker: snapshot.choker * ratio, shrinkGrow: snapshot.shrinkGrow * ratio, softness: snapshot.softness * ratio };
      analyzer = new Keylight.GLKeyer(document.createElement('canvas'));
      const analysisSink = new B.CanvasSink(track, { width: probeWidth, height: probeHeight, fit: 'fill', alpha: true, poolSize: 1 });
      const union = { left: probeWidth, top: probeHeight, right: 0, bottom: 0 };
      let index = 0;
      for await (const frame of analysisSink.canvasesAtTimestamps(schedule.map(x => x.sourceTime))) {
        abortCheck(signal);
        if (!frame) throw new Error('所选片段包含无法读取的视频帧。');
        analyzer.upload(frame.canvas);
        const box = analyzer.measureBounds(analysisParams);
        if (box) {
          union.left = Math.min(union.left, box.left); union.top = Math.min(union.top, box.top);
          union.right = Math.max(union.right, box.right); union.bottom = Math.max(union.bottom, box.bottom);
        }
        if (index++ % 8 === 0) { onProgress({ phase: '检查整段动作范围', value: 0.03 + 0.20 * index / schedule.length, frame: index, frames: schedule.length }); await tick(); }
      }
      analyzer.dispose(); analyzer = null;
      if (!(union.right > union.left && union.bottom > union.top)) throw new Error('当前抠像结果没有可见娃娃，请检查屏幕色和遮罩参数。');
      // Two low-resolution pixels pad the bound so thin edges are not trimmed.
      const bounds = {
        left: Math.max(0, union.left - 2) * sourceWidth / probeWidth,
        top: Math.max(0, union.top - 2) * sourceHeight / probeHeight,
        right: Math.min(probeWidth, union.right + 2) * sourceWidth / probeWidth,
        bottom: Math.min(probeHeight, union.bottom + 2) * sourceHeight / probeHeight
      };
      const scale = Math.min(RECT.width / (bounds.right - bounds.left), RECT.height / (bounds.bottom - bounds.top)) * SCALE;
      const placement = {
        x: Math.round(RECT.x + (RECT.width - (bounds.right - bounds.left) * scale) / 2 - bounds.left * scale),
        y: Math.round(RECT.y + (RECT.height - (bounds.bottom - bounds.top) * scale) / 2 - bounds.top * scale),
        width: Math.max(1, Math.round(sourceWidth * scale)), height: Math.max(1, Math.round(sourceHeight * scale))
      };
      const layout = { panelWidth: PANEL.width, panelHeight: PANEL.height, rect: RECT, placement };
      const canvas = document.createElement('canvas');
      keyer = new Keylight.GLKeyer(canvas);
      const target = new B.BufferTarget();
      output = new B.Output({ format: new B.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      const videoSource = new B.CanvasSource(canvas, encoderConfig);
      output.addVideoTrack(videoSource);
      await output.start();
      const sink = new B.CanvasSink(track, { alpha: true, poolSize: 1 });
      index = 0;
      for await (const frame of sink.canvasesAtTimestamps(schedule.map(x => x.sourceTime))) {
        abortCheck(signal);
        if (!frame) throw new Error('编码时缺少视频帧。');
        keyer.upload(frame.canvas);
        if (index === 0 && onCutoutFrame) {
          const cutout = document.createElement('canvas');
          keyer.renderToOffscreen(snapshot, cutout, true);
          await onCutoutFrame(cutout, { sourceTime: schedule[0].sourceTime, clipStart: start });
          abortCheck(signal);
        }
        keyer.renderPacked(snapshot, layout);
        if (index === 0 && onFirstFrame) await onFirstFrame(canvas, layout);
        const timing = schedule[index];
        await videoSource.add(timing.timestamp, timing.duration);
        index++;
        if (index % 4 === 0 || index === schedule.length) {
          onProgress({ phase: '编码拼接 MP4', value: 0.25 + 0.71 * index / schedule.length, frame: index, frames: schedule.length }); await tick();
        }
      }
      abortCheck(signal);
      if (index !== schedule.length) throw new Error('导出帧数不完整，请重试。');
      onProgress({ phase: '封装 MP4', value: 0.98, frame: index, frames: schedule.length });
      videoSource.close();
      await output.finalize(); completed = true;
      abortCheck(signal);
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      const report = { frames: index, start, end, duration: Math.round((end - start) * 1e6) / 1e6, width: PANEL.width * 2, height: PANEL.height,
        elapsedSeconds: (performance.now() - began) / 1000, bounds, placement, scale, region: RECT, audio: false };
      onProgress({ phase: '完成', value: 1, frame: index, frames: schedule.length });
      return { blob, report };
    } finally {
      if (output && !completed) { try { await output.cancel(); } catch (_) {} }
      input?.dispose(); analyzer?.dispose(); keyer?.dispose();
    }
  }
  root.PackedMp4 = Object.freeze({ exportVideo, makeSchedule, panel: PANEL, rect: RECT });
})(globalThis);
