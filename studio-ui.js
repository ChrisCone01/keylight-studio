/* Presentation-only details. Does not modify media, selection, or processing parameters. */
(() => {
  const filename = document.getElementById('studioFilename');
  const updateFilename = () => {
    if (typeof state === 'undefined') return;
    const name = state.sourceFile?.name || '尚未导入素材';
    filename.textContent = name;
    filename.title = name;
  };
  const observer = new MutationObserver(updateFilename);
  observer.observe(document.getElementById('statusMsg'), { childList: true, subtree: true, characterData: true });
  observer.observe(document.getElementById('resMsg'), { childList: true, subtree: true, characterData: true });
  updateFilename();
})();
