/* First selected keyed frame -> three transparent product images.
 * Layout and dominant-component crop follow meitu-cutout-tool/generate_static.py
 * and alpha_utils.py. No video safe-area scaling is applied to static images. */
(function (root) {
  'use strict';
  const templates = Object.freeze([
    { suffix: '商详图', width: 1125, height: 1125, box: { x: 56, y: 54, width: 1014, height: 1018 } },
    { suffix: '封面图', width: 1125, height: 1428, box: { x: 55, y: 383, width: 1014, height: 895 } },
    { suffix: '收藏柜图', width: 1125, height: 1125, box: { x: 112, y: 110, width: 902, height: 906 } }
  ]);
  function contentBounds(data, width, height) {
    const step = 8, cw = Math.ceil(width / step), ch = Math.ceil(height / step);
    const grid = new Uint8Array(cw * ch), seen = new Uint8Array(cw * ch);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= 8) grid[Math.floor(y / step) * cw + Math.floor(x / step)] = 1;
    }
    const minCells = Math.max(1, Math.floor(width * height * 0.0005 / (step * step)));
    let best = null, bestArea = 0;
    const stack = new Int32Array(cw * ch);
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i] || seen[i]) continue;
      let count = 0, size = 1, left = cw, top = ch, right = 0, bottom = 0;
      stack[0] = i; seen[i] = 1;
      while (size) {
        const index = stack[--size], x = index % cw, y = Math.floor(index / cw);
        count++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, j = ny * cw + nx;
          if (nx >= 0 && nx < cw && ny >= 0 && ny < ch && grid[j] && !seen[j]) { seen[j] = 1; stack[size++] = j; }
        }
      }
      if (count >= minCells && count > bestArea) { bestArea = count; best = { left: left * step, top: top * step, right: Math.min(width, (right + 1) * step), bottom: Math.min(height, (bottom + 1) * step) }; }
    }
    if (!best) throw new Error('第一帧没有可识别的娃娃主体，请检查选段或抠像参数。');
    let left = width, top = height, right = 0, bottom = 0;
    for (let y = best.top; y < best.bottom; y++) for (let x = best.left; x < best.right; x++) {
      if (data[(y * width + x) * 4 + 3] >= 8) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); }
    }
    return { left, top, width: right - left, height: bottom - top };
  }
  function names(filename) {
    const stem = filename.replace(/\.[^.]+$/, '').replace(/绿幕/g, '').trim().replace(/(?:的)?视频\s*$/u, '').trim() || '娃娃';
    return { stem, video: stem + '视频.mp4', bundle: stem + '导出.zip' };
  }
  async function generate(canvas, filename, signal) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const bounds = contentBounds(pixels.data, canvas.width, canvas.height);
    const { stem } = names(filename), images = [];
    for (const template of templates) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const box = template.box, ratio = bounds.width / bounds.height;
      const wide = ratio > box.width / box.height;
      const width = Math.max(1, wide ? box.width : Math.floor(box.height * ratio));
      const height = Math.max(1, wide ? Math.floor(box.width / ratio) : box.height);
      const x = box.x + Math.floor((box.width - width) / 2), y = box.y + Math.floor((box.height - height) / 2);
      const target = document.createElement('canvas'); target.width = template.width; target.height = template.height;
      const draw = target.getContext('2d'); draw.imageSmoothingEnabled = true; draw.imageSmoothingQuality = 'high';
      draw.drawImage(canvas, bounds.left, bounds.top, bounds.width, bounds.height, x, y, width, height);
      const blob = await new Promise(resolve => target.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(template.suffix + '生成失败。');
      images.push({ name: stem + template.suffix + '.png', blob, width: template.width, height: template.height, placement: { x, y, width, height } });
    }
    return { images, bounds };
  }
  root.StaticImages = Object.freeze({ templates, names, contentBounds, generate });
})(globalThis);
