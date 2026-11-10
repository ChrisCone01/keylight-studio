/* One job in, one complete set of files out. No shared editor state. */
(function(root) {
  'use strict';
  async function create(job, { signal, onProgress = () => {} } = {}) {
    if (typeof LottieBundle === 'undefined') throw new Error('内置 Lottie 模板未加载。');
    const exportParams = { ...JSON.parse(JSON.stringify(job.params)), layerCount: 3 };
    let staticOutput, firstFrameTime;
    const { blob, report } = await PackedMp4.exportVideo({
      file: job.file, params: exportParams, frameTimes: job.frameExact ? job.frameTimes : null,
      start: job.clipIn, end: job.clipOut, signal,
      onProgress: info => onProgress({ ...info, value: info.value * 0.92 }),
      async onCutoutFrame(canvas, timing) {
        onProgress({ phase: '生成首帧三张图', value: 0.23 });
        staticOutput = await StaticImages.generate(canvas, job.file.name, signal);
        firstFrameTime = timing.sourceTime;
      }
    });
    if (!staticOutput || staticOutput.images.length !== 3) throw new Error('首帧静态图没有生成完整。');
    if (signal?.aborted) throw new DOMException('已取消导出', 'AbortError');
    const names = StaticImages.names(job.file.name);
    const detail = staticOutput.images.find(image => image.name === names.stem + '商详图.png');
    if (!detail) throw new Error('缺少商详图，无法替换 Lottie 图片。');
    const lottieFiles = LottieBundle.createFiles(detail.blob, signal);
    const files = [{ name: names.video, blob }, ...staticOutput.images, ...lottieFiles];
    Object.assign(report, {
      layerCount: 3,
      images: staticOutput.images.map(({ name, width, height, placement }) => ({ name, width, height, placement })),
      lottie: { folder: 'Lottie', files: lottieFiles.length, replaced: 'images/img_0.png' },
      staticSourceBounds: staticOutput.bounds, staticSourceTime: firstFrameTime
    });
    return { files, report, names };
  }
  root.MaterialExport = Object.freeze({ create });
})(globalThis);
