/* Local MP4/MOV presentation-time reader. No codec decode or media payload read.
 * FrameTimeline.read(blob) -> { times, exact, source, duration, ... }
 * Throws TimelineError for unsupported/invalid files; callers must label fallback
 * navigation as approximate. This module does not alter the source video.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrameTimeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({ moovBytes: 64 * 1024 * 1024, samples: 1000000, boxes: 20000, edits: 10000 });

  class TimelineError extends Error {
    constructor(message, code = 'INVALID_MP4') { super(message); this.name = 'TimelineError'; this.code = code; }
  }
  function invalid(message) { throw new TimelineError(message); }
  function unsupported(message) { throw new TimelineError(message, 'UNSUPPORTED'); }
  function bounded(condition, message) { if (!condition) invalid(message); }
  function safeInteger(value, message) { bounded(Number.isSafeInteger(value), message); return value; }
  function need(view, start, length, end = view.byteLength) {
    bounded(Number.isInteger(start) && Number.isInteger(length) && start >= 0 && length >= 0 && start + length <= end && end <= view.byteLength, 'Truncated MP4 metadata.');
  }
  function uint64(view, offset, end) {
    need(view, offset, 8, end);
    return safeInteger(view.getUint32(offset) * 4294967296 + view.getUint32(offset + 4), 'MP4 integer exceeds JavaScript precision.');
  }
  function int64(view, offset, end) {
    need(view, offset, 8, end);
    return safeInteger(view.getInt32(offset) * 4294967296 + view.getUint32(offset + 4), 'MP4 signed integer exceeds JavaScript precision.');
  }
  function typeAt(view, offset) {
    need(view, offset, 4);
    return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  }
  function fullVersion(view, box, supported) {
    need(view, box.data, 4, box.end);
    const version = view.getUint8(box.data);
    if (!supported.includes(version)) unsupported('Unsupported ' + box.type + ' version ' + version + '.');
    return version;
  }

  function boxes(view, start, end, budget) {
    const out = [];
    for (let offset = start; offset < end;) {
      need(view, offset, 8, end);
      if (++budget.count > LIMITS.boxes) invalid('Too many MP4 metadata boxes.');
      let size = view.getUint32(offset), header = 8;
      const type = typeAt(view, offset + 4);
      if (size === 1) { size = uint64(view, offset + 8, end); header = 16; }
      else if (size === 0) size = end - offset;
      bounded(size >= header && size <= end - offset, 'Invalid size for ' + type + ' box.');
      out.push({ type, offset, data: offset + header, end: offset + size, size });
      offset += size;
    }
    return out;
  }
  function one(items, type, required = true) {
    const matches = items.filter(item => item.type === type);
    if (!matches.length && required) unsupported('Missing ' + type + ' sample metadata.');
    if (matches.length > 1) unsupported('Multiple ' + type + ' boxes are not supported.');
    return matches[0] || null;
  }
  function children(view, box, budget) { return boxes(view, box.data, box.end, budget); }

  async function bytes(blob, offset, length) {
    bounded(offset >= 0 && length >= 0 && offset + length <= blob.size, 'MP4 read outside file bounds.');
    const buffer = await blob.slice(offset, offset + length).arrayBuffer();
    bounded(buffer.byteLength === length, 'Incomplete local file read.');
    return new DataView(buffer);
  }

  async function findMoov(blob) {
    let count = 0;
    for (let offset = 0; offset < blob.size;) {
      if (++count > LIMITS.boxes) invalid('Too many top-level MP4 boxes.');
      bounded(blob.size - offset >= 8, 'Incomplete MP4 box header.');
      const head = await bytes(blob, offset, 8);
      let size = head.getUint32(0), header = 8;
      const type = typeAt(head, 4);
      if (size === 1) {
        bounded(blob.size - offset >= 16, 'Incomplete extended MP4 box header.');
        size = uint64(await bytes(blob, offset + 8, 8), 0, 8); header = 16;
      } else if (size === 0) size = blob.size - offset;
      bounded(size >= header && size <= blob.size - offset, 'Invalid top-level ' + type + ' box size.');
      if (type === 'moov') {
        bounded(size <= LIMITS.moovBytes, 'MP4 metadata exceeds the 64 MiB limit.');
        const view = await bytes(blob, offset, size);
        return { view, box: { type, offset: 0, data: header, end: size, size }, bytesRead: size, fileOffset: offset };
      }
      // Skip mdat/free/etc by their declared byte length; never read their payload.
      offset += size;
    }
    unsupported('No MP4/MOV moov box found.');
  }

  function timeHeader(view, box) {
    const v = fullVersion(view, box, [0, 1]);
    const scaleOffset = box.data + (v === 1 ? 20 : 12);
    need(view, scaleOffset, v === 1 ? 12 : 8, box.end);
    const timescale = view.getUint32(scaleOffset);
    bounded(timescale > 0, 'Zero ' + box.type + ' timescale.');
    const duration = v === 1 ? uint64(view, scaleOffset + 4, box.end) : view.getUint32(scaleOffset + 4);
    return { timescale, duration };
  }

  function trackHeader(view, box) {
    if (!box) return { trackId: null, enabled: true };
    const v = fullVersion(view, box, [0, 1]);
    const idOffset = box.data + (v === 1 ? 20 : 12);
    need(view, idOffset, 4, box.end);
    return { trackId: view.getUint32(idOffset), enabled: (view.getUint8(box.data + 3) & 1) !== 0 };
  }

  function timingTable(view, box, composition) {
    const version = fullVersion(view, box, composition ? [0, 1] : [0]);
    need(view, box.data + 4, 4, box.end);
    const count = view.getUint32(box.data + 4);
    bounded(count <= LIMITS.samples, 'Too many timing entries.');
    need(view, box.data + 8, count * 8, box.end);
    let sampleCount = 0;
    const rows = [];
    for (let i = 0; i < count; i++) {
      const offset = box.data + 8 + i * 8;
      const samples = view.getUint32(offset);
      const value = composition && version === 1 ? view.getInt32(offset + 4) : view.getUint32(offset + 4);
      bounded(samples > 0, 'Timing table contains an empty run.');
      sampleCount += samples;
      bounded(sampleCount <= LIMITS.samples, 'Video exceeds the one-million-sample limit.');
      if (!composition) bounded(value > 0, 'Zero-duration video samples are not supported.');
      rows.push([samples, value]);
    }
    return { rows, sampleCount, version };
  }

  function editList(view, edts, budget) {
    if (!edts) return null;
    const elst = one(children(view, edts, budget), 'elst', false);
    if (!elst) return null;
    const version = fullVersion(view, elst, [0, 1]);
    need(view, elst.data + 4, 4, elst.end);
    const count = view.getUint32(elst.data + 4), stride = version === 1 ? 20 : 12;
    bounded(count <= LIMITS.edits, 'Too many edit-list segments.');
    need(view, elst.data + 8, count * stride, elst.end);
    const edits = [];
    for (let i = 0; i < count; i++) {
      const p = elst.data + 8 + i * stride;
      const duration = version === 1 ? uint64(view, p, elst.end) : view.getUint32(p);
      const mediaTime = version === 1 ? int64(view, p + 8, elst.end) : view.getInt32(p + 4);
      const rateOffset = p + (version === 1 ? 16 : 8);
      const rateInteger = view.getInt16(rateOffset), rateFraction = view.getInt16(rateOffset + 2);
      if (rateInteger !== 1 || rateFraction !== 0) unsupported('Dwell/reverse/rate-changing edit lists are not supported.');
      bounded(mediaTime >= -1, 'Invalid negative edit media time.');
      edits.push({ duration, mediaTime });
    }
    return edits.length ? edits : null;
  }

  function expandTimes(stts, ctts) {
    if (!stts.sampleCount) unsupported('Empty video sample table (fragmented MP4 is not supported).');
    if (ctts) bounded(ctts.sampleCount === stts.sampleCount, 'stts and ctts sample counts differ.');
    const pts = new Array(stts.sampleCount);
    let index = 0, decodeTime = 0, compositionEnd = 0, compRow = 0, compLeft = ctts ? ctts.rows[0][0] : 0;
    for (const [count, delta] of stts.rows) {
      safeInteger(decodeTime + count * delta, 'Video timestamp exceeds JavaScript precision.');
      for (let j = 0; j < count; j++) {
        const offset = ctts ? ctts.rows[compRow][1] : 0;
        pts[index++] = safeInteger(decodeTime + offset, 'Presentation timestamp exceeds JavaScript precision.');
        compositionEnd = Math.max(compositionEnd, safeInteger(decodeTime + offset + delta, 'Presentation end exceeds JavaScript precision.'));
        decodeTime += delta;
        if (ctts && --compLeft === 0 && ++compRow < ctts.rows.length) compLeft = ctts.rows[compRow][0];
      }
    }
    pts.sort((a, b) => a - b);
    // Two coded samples with the same PTS cannot be sought independently by time.
    // Refuse to call that an exact frame-navigation map.
    for (let i = 1; i < pts.length; i++) if (pts[i] === pts[i - 1]) unsupported('Duplicate presentation timestamps prevent exact frame stepping.');
    return { pts, decodeDuration: decodeTime, compositionEnd };
  }

  function lowerBound(times, t) {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function upperBound(times, t) {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function atOrBefore(times, t) {
    if (!times.length || !Number.isFinite(t)) return -1;
    return Math.max(0, Math.min(times.length - 1, upperBound(times, t) - 1));
  }
  function nearest(times, t) {
    if (!times.length || !Number.isFinite(t)) return -1;
    const right = lowerBound(times, t);
    if (!right) return 0;
    if (right === times.length) return right - 1;
    return t - times[right - 1] <= times[right] - t ? right - 1 : right;
  }
  function step(times, t, count) {
    // A playback clock may lie between PTS values. Step from the frame being
    // displayed, not from the nearest future frame (which would skip a frame).
    const index = atOrBefore(times, t);
    if (index < 0) return -1;
    return Math.max(0, Math.min(times.length - 1, index + Math.trunc(Number.isFinite(count) ? count : 0)));
  }

  function mapEdits(pts, media, movie, edits, decodeDuration, compositionEnd) {
    const durationUnits = Math.max(media.duration || decodeDuration, compositionEnd);
    const mediaEnd = durationUnits / media.timescale;
    const seconds = pts.map(value => value / media.timescale);
    if (!edits) {
      const startIndex = Math.max(0, upperBound(seconds, 0) - 1);
      const times = seconds.slice(startIndex).filter(t => t < mediaEnd).map(t => Math.max(0, t));
      return { times, duration: mediaEnd, hasEdits: false, emptyEdits: [] };
    }
    const times = [], emptyEdits = [];
    let position = 0;
    for (const edit of edits) {
      const span = edit.duration / movie.timescale;
      if (!span) continue;
      const next = position + span;
      bounded(Number.isFinite(next), 'Invalid edited duration.');
      if (edit.mediaTime === -1) { emptyEdits.push({ start: position, end: next }); position = next; continue; }
      const startTick = edit.mediaTime;
      const endTick = startTick + span * media.timescale;
      // Include a frame already active at the cut point, clipped to the edit start.
      // Comparison is in seconds with a tiny scale-relative tolerance for divisions.
      const tolerance = Math.min(1e-9, 0.01 / media.timescale);
      const tickTolerance = tolerance * media.timescale;
      let index = lowerBound(pts, startTick - tickTolerance);
      if (index > 0 && (index === pts.length || pts[index] > startTick + tickTolerance)) index--;
      for (; index < pts.length && pts[index] < endTick - tickTolerance; index++) {
        const mapped = position + Math.max(0, (pts[index] - startTick) / media.timescale);
        if (mapped < next - tolerance) times.push(mapped);
        bounded(times.length <= LIMITS.samples, 'Edited timeline exceeds the sample limit.');
      }
      position = next;
    }
    return { times, duration: position, hasEdits: true, emptyEdits };
  }

  async function read(blob) {
    if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 8 || typeof blob.slice !== 'function') unsupported('Expected a local MP4/MOV File or Blob.');
    const metadata = await findMoov(blob), view = metadata.view, budget = { count: 0 };
    const moov = children(view, metadata.box, budget);
    if (one(moov, 'mvex', false)) unsupported('Fragmented MP4 timing is not supported.');
    const movie = timeHeader(view, one(moov, 'mvhd'));
    const candidates = [];
    for (const track of moov.filter(box => box.type === 'trak')) {
      const parts = children(view, track, budget), mdia = one(parts, 'mdia');
      const mediaParts = children(view, mdia, budget), handler = one(mediaParts, 'hdlr');
      fullVersion(view, handler, [0]); need(view, handler.data + 8, 4, handler.end);
      if (typeAt(view, handler.data + 8) !== 'vide') continue;
      candidates.push({ ...trackHeader(view, one(parts, 'tkhd', false)), parts, mediaParts });
    }
    if (!candidates.length) unsupported('No video track in MP4/MOV.');
    const enabled = candidates.filter(track => track.enabled);
    if (enabled.length > 1) unsupported('Multiple enabled video tracks require explicit track selection.');
    const selected = enabled[0] || (candidates.length === 1 ? candidates[0] : null);
    if (!selected) unsupported('Ambiguous video track selection.');
    const media = timeHeader(view, one(selected.mediaParts, 'mdhd'));
    const minf = one(selected.mediaParts, 'minf');
    const stbl = one(children(view, minf, budget), 'stbl');
    const sampleTables = children(view, stbl, budget);
    const stts = timingTable(view, one(sampleTables, 'stts'), false);
    const cttsBox = one(sampleTables, 'ctts', false);
    const ctts = cttsBox ? timingTable(view, cttsBox, true) : null;
    const stsz = one(sampleTables, 'stsz', false);
    if (stsz) {
      fullVersion(view, stsz, [0]); need(view, stsz.data + 4, 8, stsz.end);
      bounded(view.getUint32(stsz.data + 8) === stts.sampleCount, 'stsz and stts sample counts differ.');
      if (view.getUint32(stsz.data + 4) === 0) need(view, stsz.data + 12, stts.sampleCount * 4, stsz.end);
    }
    const stz2 = one(sampleTables, 'stz2', false);
    if (stz2) {
      fullVersion(view, stz2, [0]); need(view, stz2.data + 4, 8, stz2.end);
      const fieldSize = view.getUint8(stz2.data + 7);
      bounded([4, 8, 16].includes(fieldSize), 'Invalid compact sample-size field width.');
      bounded(view.getUint32(stz2.data + 8) === stts.sampleCount, 'stz2 and stts sample counts differ.');
      need(view, stz2.data + 12, Math.ceil(stts.sampleCount * fieldSize / 8), stz2.end);
    }
    const { pts, decodeDuration, compositionEnd } = expandTimes(stts, ctts);
    const edits = editList(view, one(selected.parts, 'edts', false), budget);
    const timeline = mapEdits(pts, media, movie, edits, decodeDuration, compositionEnd);
    if (!timeline.times.length) unsupported('Video has no visible frames in its edit timeline.');
    for (let i = 0; i < timeline.times.length; i++) {
      const t = timeline.times[i];
      bounded(Number.isFinite(t) && t >= 0 && t < timeline.duration, 'Invalid presentation time.');
      if (i) bounded(t > timeline.times[i - 1], 'Edit list creates ambiguous presentation timestamps.');
    }
    return {
      times: timeline.times, exact: true, source: 'MP4', duration: timeline.duration,
      timescale: media.timescale, movieTimescale: movie.timescale,
      trackId: selected.trackId, sampleCount: stts.sampleCount, frameCount: timeline.times.length,
      hasCompositionOffsets: Boolean(ctts), hasEdits: timeline.hasEdits,
      emptyEdits: timeline.emptyEdits, metadataBytes: metadata.bytesRead,
    };
  }

  // Helpers return indices (or -1 for an empty list / invalid time), not seconds.
  return { read, nearest, atOrBefore, step, TimelineError, LIMITS };
});
