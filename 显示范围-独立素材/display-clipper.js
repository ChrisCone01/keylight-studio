/* Independent display constraint; not loaded by the keying webpage. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DollDisplayRegion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const canvasSize = Object.freeze({ width: 1136, height: 1424 });
  const rect = Object.freeze({ x: 62, y: 307, width: 1014, height: 1052 });
  const margins = Object.freeze({ left: 62, right: 60, top: 307, bottom: 65 });

  // Position and size are explicit: clipping must never silently scale the doll.
  function draw(source, targetCanvas, placement) {
    if (!source || !targetCanvas || source === targetCanvas) throw new Error('Source and target must be separate.');
    if (!placement || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(placement[k])) || placement.width <= 0 || placement.height <= 0) {
      throw new Error('Provide finite x/y and positive width/height.');
    }
    const ctx = targetCanvas.getContext('2d');
    if (!ctx || ctx.getContextAttributes?.().alpha === false) throw new Error('Target requires a 2D canvas with alpha enabled.');
    // Reset dimensions, clipping state, transform and all old frame pixels.
    targetCanvas.width = canvasSize.width;
    targetCanvas.height = canvasSize.height;
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      ctx.drawImage(source, placement.x, placement.y, placement.width, placement.height);
    } finally { ctx.restore(); }
    return targetCanvas;
  }

  function clipCanvas(sourceCanvas, targetCanvas) {
    if (sourceCanvas.width !== canvasSize.width || sourceCanvas.height !== canvasSize.height) {
      throw new Error('The composed source canvas must be 1136 × 1424 pixels.');
    }
    return draw(sourceCanvas, targetCanvas, { x: 0, y: 0, ...canvasSize });
  }
  return Object.freeze({ canvasSize, rect, margins, draw, clipCanvas });
});
