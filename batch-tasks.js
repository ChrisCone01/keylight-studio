/* Session-local per-file settings and sequential batch export. Files never leave the browser. */
(function(root) {
  'use strict';
  const tasks = [];
  let activeId = null, switching = false, serial = 0;
  let thumbnailWorkers = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const videoFile = f => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v|ogv)$/i.test(f.name);
  const imageFile = f => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);
  const active = () => tasks.find(t => t.id === activeId);
  function folderBase(filename) {
    let value = StaticImages.names(filename).stem;
    value = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
    if (!value) value = '素材';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = '_' + value;
    return value;
  }
  function uniqueFolders(items) {
    const used = new Set();
    return items.map(item => {
      const base = folderBase(item.file.name); let name = base, number = 2;
      while (used.has(name.toLocaleLowerCase())) name = `${base} (${number++})`;
      used.add(name.toLocaleLowerCase()); return name;
    });
  }
  function stamp(task) { return JSON.stringify({ params: task.params, layers: task.layers, clipIn: task.clipIn, clipOut: task.clipOut }); }
  function saveActive() {
    const task = active();
    if (!task?.initialized || switching || state.sourceFile !== task.file) return;
    task.params = clone(state.params); task.layers = clone(state.layers);
    task.clipIn = state.clipIn; task.clipOut = state.clipOut;
    task.previewFrame = state.isVideo && !state.source.paused ? floorFrame(state.source.currentTime) : state.requestedFrame;
    task.frameTimes = state.frameTimes.slice(); task.frameExact = state.frameExact;
    task.estimateFps = Number($('estimateFps').value) || 30;
    task.history = { stack: history.stack.slice(), index: history.index };
    task.edited = stamp(task) !== task.initialStamp;
  }
  function updateButtons() {
    const videos = tasks.filter(t => t.video);
    $('batchCount').textContent = `${tasks.length} 个素材`;
    $('btnBatchDownload').disabled = !videos.length || switching || state.exporting;
    $('btnBatchDownload').textContent = '下载全部素材';
    const task = active();
    $('btnPackedMp4').disabled = !task?.video || !task.initialized || switching || state.exporting || state.sourceFile !== task.file || !state.frameTimes.length;
    $('taskQueue').hidden = !tasks.length;
    requestAnimationFrame(updateStripNavigation);
  }
  function render() {
    const list = $('taskList'), scroll = list.scrollLeft; list.replaceChildren();
    for (const task of tasks) {
      const row = document.createElement('div'); row.className = 'task-row' + (task.id === activeId ? ' active' : ''); row.dataset.taskId = task.id;
      const open = document.createElement('button'); open.type = 'button'; open.className = 'task-open'; open.disabled = switching || state.exporting;
      open.title = task.relativePath || task.file.name; open.setAttribute('aria-pressed', String(task.id === activeId));
      const name = document.createElement('span'); name.className = 'task-name'; name.textContent = task.file.name;
      const visual = document.createElement('span'); visual.className = 'task-visual';
      if (task.thumbnail) {
        const img = document.createElement('img'); img.src = task.thumbnail; img.alt = task.file.name; img.draggable = false;
        visual.append(img);
      } else { const placeholder = document.createElement('span'); placeholder.className = 'task-placeholder'; placeholder.textContent = task.thumbError ? '无法预览' : '预览生成中'; visual.append(placeholder); }
      open.append(visual, name); open.onclick = () => selectTask(task.id);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'task-remove'; remove.textContent = '×';
      remove.title = '移出列表（不删除本地文件）'; remove.setAttribute('aria-label', '移除 ' + task.file.name); remove.disabled = switching || state.exporting;
      remove.onclick = () => removeTask(task.id);
      row.append(open, remove); list.append(row);
    }
    list.scrollLeft = scroll; updateButtons();
  }
  function captureThumbnail(source, task) {
    const w = source.videoWidth || source.naturalWidth || source.width, h = source.videoHeight || source.naturalHeight || source.height;
    if (!w || !h || task.thumbnail) return;
    const scale = Math.min(1, 320 / w, 320 / h), canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    task.thumbnail = canvas.toDataURL('image/jpeg', 0.84);
  }
  async function makeThumbnail(task) {
    const url = URL.createObjectURL(task.file), source = task.video ? document.createElement('video') : new Image();
    if (task.video) { source.muted = true; source.playsInline = true; source.preload = 'auto'; }
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('预览超时')), 10000);
        const finish = error => { clearTimeout(timer); source.onload = source.onloadeddata = source.onerror = null; error ? reject(error) : resolve(); };
        if (task.video) source.onloadeddata = () => finish(); else source.onload = () => finish();
        source.onerror = () => finish(new Error('无法预览')); source.src = url;
      });
      if (tasks.includes(task)) captureThumbnail(source, task);
    } catch (_) { task.thumbError = true; }
    finally { if (task.video) { source.pause(); source.removeAttribute('src'); source.load(); } URL.revokeObjectURL(url); }
  }
  function pumpThumbnails() {
    while (thumbnailWorkers < 2) {
      const task = tasks.find(t => !t.thumbnail && !t.thumbLoading && !t.thumbError);
      if (!task) return;
      task.thumbLoading = true; thumbnailWorkers++;
      makeThumbnail(task).finally(() => { task.thumbLoading = false; thumbnailWorkers--; render(); pumpThumbnails(); });
    }
  }
  async function prepareTask(task) {
    if (task.initialized) return task;
    task.error = null;
    const url = URL.createObjectURL(task.file);
    const source = task.video ? document.createElement('video') : new Image();
    const tablePromise = task.video ? FrameTimeline.read(task.file).catch(() => null) : Promise.resolve(null);
    if (task.video) { source.muted = true; source.playsInline = true; source.preload = 'auto'; }
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('读取素材超时')), 15000);
        const finish = error => { clearTimeout(timer); source.onload = source.onloadeddata = source.onerror = null; error ? reject(error) : resolve(); };
        if (task.video) source.onloadeddata = () => finish(); else source.onload = () => finish();
        source.onerror = () => finish(new Error('素材无法解码'));
        source.src = url;
      });
      const w = source.videoWidth || source.naturalWidth, h = source.videoHeight || source.naturalHeight;
      if (!w || !h || (task.video && !(Number.isFinite(source.duration) && source.duration > 0))) throw new Error('素材尺寸或时长无效');
      captureThumbnail(source, task);
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(source, 0, 0);
      const pixels = ctx.getImageData(0, 0, w, h).data;
      const screen = Keylight.autoSample(pixels, w, h);
      const params = defaultParams();
      if (Math.max(...screen) - Math.min(...screen) >= 0.06 && Math.max(...screen) >= 24 / 255) params.screen = screen;
      const table = await tablePromise;
      task.duration = task.video ? source.duration : 0;
      task.frameTimes = table?.times?.filter(t => t >= 0 && t < task.duration - 1e-7) || [];
      task.frameExact = !!table?.exact && task.frameTimes.length > 0;
      if (task.video && !task.frameTimes.length) task.frameTimes = Array.from({ length: Math.min(500000, Math.ceil(task.duration * 30)) }, (_, i) => i / 30);
      Object.assign(task, { params: clone(params), layers: [], clipIn: 0, clipOut: Math.min(4, task.duration), previewFrame: 0, estimateFps: 30, history: null, initialized: true, edited: false });
      task.initialStamp = stamp(task);
      return task;
    } catch (error) { task.error = error.message; throw error; }
    finally { if (task.video) { source.pause(); source.removeAttribute('src'); source.load(); } URL.revokeObjectURL(url); }
  }
  async function selectTask(id) {
    if (state.exporting || switching) return false;
    const task = tasks.find(t => t.id === id); if (!task) return false;
    if (activeId === id && task.initialized && state.sourceFile === task.file && !task.error) return true;
    await waitForScrub();
    if (state.exporting || switching) return false;
    saveActive(); pauseForScrub();
    switching = true; activeId = id; render();
    const editorControls = [...document.querySelectorAll('.inspector-scroll .section:not(.queue-section):not(.import-section) button, .inspector-scroll .section:not(.queue-section):not(.import-section) input')];
    const disabled = editorControls.map(e => e.disabled); editorControls.forEach(e => e.disabled = true);
    try {
      setStatus('正在载入 ' + task.file.name);
      await prepareTask(task);
      await openMedia(task.file, task);
      task.error = null;
      return true;
    } catch (error) { task.error = error.message; setStatus(task.file.name + '：' + error.message); return false; }
    finally {
      switching = false; editorControls.forEach((e, i) => e.disabled = disabled[i]); saveActive(); render();
      const card = $('taskList').querySelector(`[data-task-id="${id}"]`);
      if (card) { const list = $('taskList'), bounds = list.getBoundingClientRect(), box = card.getBoundingClientRect(); if (box.left < bounds.left) list.scrollLeft += box.left - bounds.left; else if (box.right > bounds.right) list.scrollLeft += box.right - bounds.right; }
    }
  }
  async function addFiles(input, { videosOnly = false } = {}) {
    if (state.exporting) return;
    let added = 0, ignored = 0;
    for (const item of Array.from(input)) {
      const file = item.file || item, relativePath = item.path || file.webkitRelativePath || file.name;
      const video = videoFile(file);
      if (!video && (videosOnly || !imageFile(file))) { ignored++; continue; }
      const key = `${relativePath}|${file.size}|${file.lastModified}`;
      if (tasks.some(t => t.key === key)) continue;
      tasks.push({ id: 'asset-' + (++serial), key, file, relativePath, video, initialized: false, params: null, layers: [], edited: false, error: null, processing: false });
      added++;
    }
    render();
    if (!activeId && tasks.length) await selectTask(tasks[0].id);
    pumpThumbnails();
    if (added) setStatus(`已加入 ${added} 个素材，共 ${tasks.length} 个；点击名称分别调节${ignored ? `（忽略 ${ignored} 个非视频文件）` : ''}`);
    else setStatus(ignored ? '没有可加入的视频文件' : '这些素材已在列表中');
  }
  async function removeTask(id) {
    if (switching || state.exporting) return;
    await waitForScrub();
    if (switching || state.exporting) return;
    saveActive();
    const index = tasks.findIndex(t => t.id === id); if (index < 0) return;
    const wasActive = activeId === id; tasks.splice(index, 1);
    if (!wasActive) return render();
    activeId = null;
    if (tasks.length) await selectTask(tasks[Math.min(index, tasks.length - 1)].id);
    else {
      if (state.isVideo && state.source) state.source.pause();
      ++state.loadToken; if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
      state.source = state.sourceFile = state.sourceUrl = null; state.frameTimes = []; state.isVideo = false;
      state.layers = []; state.params = defaultParams(); state.pendingFrame = null; state.seekJob = null;
      syncUI();  history.stack = []; history.index = -1; pushHistory();
      view.style.display = 'none'; $('empty').style.display = 'flex';
      $('rangeTrack').classList.add('empty'); $('frameReadout').textContent = '尚未载入帧'; $('btnPlay').disabled = true;
      setFrameControls(false); setStatus('已清空素材列表'); render();
    }
  }
  function pickFolder() {
    if (state.exporting) return;
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
    input.setAttribute('webkitdirectory', ''); input.accept = 'video/*';
    input.onchange = () => addFiles(input.files, { videosOnly: true }); input.click();
  }
  async function readEntry(entry, out) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: entry.fullPath.replace(/^\//, '') });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const chunk = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!chunk.length) break;
        for (const child of chunk) await readEntry(child, out);
      }
    }
  }
  async function handleDrop(event) {
    event.preventDefault(); $('stage').classList.remove('dragover');
    if (state.exporting) return;
    const files = Array.from(event.dataTransfer.files);
    const entries = Array.from(event.dataTransfer.items || []).map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    try {
      if (entries.some(entry => entry.isDirectory)) {
        const collected = []; for (const entry of entries) await readEntry(entry, collected);
        await addFiles(collected, { videosOnly: true });
      } else await addFiles(files);
    } catch (error) { setStatus('读取拖入文件失败：' + error.message); }
  }
  async function exportTasks(items, batch) {
    if (state.exporting || switching || !items.length) return;
    await waitForScrub(); if (state.exporting || switching) return;
    saveActive();
    const jobs = items.filter(task => task.video), folders = uniqueFolders(jobs);
    if (!jobs.length) return setStatus('请选择视频素材');
    const currentVideo = state.source, wasPlaying = state.isVideo && currentVideo && !currentVideo.paused;
    pauseForScrub(); state.exporting = state.capturing = true;
    packedAbort = new AbortController();
    const signal = packedAbort.signal, began = performance.now();
    const controls = [...document.querySelectorAll('#side button,#side input,#side select,#timelineWrap button,#timelineWrap input,#rangeLabels button')].filter(e => e.id !== 'btnPackedCancel');
    const previous = controls.map(e => e.disabled); controls.forEach(e => e.disabled = true);
    $('packedProgressBox').hidden = false; $('packedProgress').value = 0; $('btnPackedCancel').disabled = false;
    const archive = new ZipWriter(), reports = [];
    let currentTask = null;
    try {
      for (let index = 0; index < jobs.length; index++) {
        if (signal.aborted) throw new DOMException('已取消导出', 'AbortError');
        currentTask = jobs[index]; currentTask.processing = true; currentTask.error = null; render();
        $('packedProgressText').textContent = `准备 ${index + 1}/${jobs.length} · ${folderBase(currentTask.file.name)}`;
        await prepareTask(currentTask);
        const job = { file: currentTask.file, params: clone(currentTask.params), frameTimes: currentTask.frameTimes.slice(), frameExact: currentTask.frameExact, clipIn: currentTask.clipIn, clipOut: currentTask.clipOut };
        const result = await MaterialExport.create(job, { signal, onProgress(info) {
          $('packedProgress').value = (index + info.value) / jobs.length;
          $('packedProgressText').textContent = `${index + 1}/${jobs.length} · ${info.phase} ${Math.round(info.value * 100)}%`;
        }});
        for (let k = 0; k < result.files.length; k++) {
          if (signal.aborted) throw new DOMException('已取消导出', 'AbortError');
          const file = result.files[k];
          archive.add((batch ? folders[index] + '/' : '') + file.name, new Uint8Array(await file.blob.arrayBuffer()));
          $('packedProgress').value = (index + 0.92 + 0.08 * (k + 1) / result.files.length) / jobs.length;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        reports.push({ id: currentTask.id, filename: currentTask.file.name, folder: batch ? folders[index] : null, settings: clone(job.params), report: result.report });
        currentTask.processing = false; render();
      }
      if (signal.aborted) throw new DOMException('已取消导出', 'AbortError');
      const filename = batch ? '娃娃素材合集.zip' : StaticImages.names(jobs[0].file.name).bundle;
      download(archive.finish(), filename);
      jobs.forEach(task => task.lastExportStamp = stamp(task));
      state.lastBatchExport = { tasks: reports, seconds: (performance.now() - began) / 1000, filename };
      if (!batch) state.lastPackedExport = reports[0].report;
      setStatus(`已下载 ${jobs.length} 个娃娃的素材 · ${((performance.now() - began) / 1000).toFixed(1)}s`);
    } catch (error) {
      if (error.name === 'AbortError') setStatus('已取消下载，未生成不完整的压缩包');
      else { if (currentTask) currentTask.error = '导出失败：' + error.message; setStatus(`${currentTask?.file.name || ''} 导出失败，未下载压缩包：${error.message}`); }
      console.warn(error);
    } finally {
      jobs.forEach(task => task.processing = false);
      packedAbort = null; state.exporting = state.capturing = false;
      controls.forEach((e, i) => e.disabled = previous[i]); $('packedProgressBox').hidden = true;
      render(); needRender = true;
      if (wasPlaying && state.source === currentVideo) currentVideo.play().catch(() => {});
    }
  }
  $('btnFolder').onclick = pickFolder;
  function updateStripNavigation() {
    const list = $('taskList');
    const overflow = !$('taskQueue').hidden && list.scrollWidth > list.clientWidth + 1;
    $('taskScrollPrev').hidden = $('taskScrollNext').hidden = !overflow;
    $('taskScrollPrev').disabled = !overflow || list.scrollLeft <= 1;
    $('taskScrollNext').disabled = !overflow || list.scrollLeft >= list.scrollWidth - list.clientWidth - 1;
  }
  new ResizeObserver(updateStripNavigation).observe($('taskList'));
  $('taskList').addEventListener('scroll', updateStripNavigation, { passive: true });
  $('taskScrollPrev').onclick = () => $('taskList').scrollBy({ left: -360, behavior: 'smooth' });
  $('taskScrollNext').onclick = () => $('taskList').scrollBy({ left: 360, behavior: 'smooth' });
  $('btnBatchDownload').onclick = () => exportTasks(tasks.filter(task => task.video), true);
  // Save on task switches and exports, plus show edit status as settings change.
  document.addEventListener('input', event => {
    if (switching || state.exporting || event.target.closest('#taskQueue')) return;
    if (event.target.closest('#side')) { saveActive(); render(); }
  });
  document.addEventListener('click', event => {
    if (event.target.closest('#taskQueue') || switching || state.exporting) return;
    if (event.target.closest('#side') || event.target.closest('#rangeLabels')) setTimeout(() => { if (!switching && !state.exporting) { saveActive(); render(); } }, 0);
  });
  root.BatchTasks = Object.freeze({ addFiles, selectTask, saveActive, removeTask, handleDrop, pickFolder, prepareTask, exportTasks, folderBase, uniqueFolders, refresh: render,
    downloadActive: () => { const task = active(); return task ? exportTasks([task], false) : Promise.resolve(); },
    get items() { return tasks; }, get activeId() { return activeId; }, get switching() { return switching; }
  });
  render();
})(globalThis);
