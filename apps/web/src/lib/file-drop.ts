const explicitTarget = (event: DragEvent) =>
  event.defaultPrevented ||
  (event.target instanceof Element &&
    !!event.target.closest('input[type="file"], [data-file-drop]'));

export function isFileDrag(transfer: DataTransfer | null) {
  return !!transfer && [...transfer.types].includes('Files');
}

export function acceptsFileDrag(transfer: DataTransfer | null) {
  if (!isFileDrag(transfer)) return false;
  // Browsers may hide MIME types until drop. The server validates actual bytes.
  return (
    transfer!.items.length === 0 ||
    [...transfer!.items].some(
      (item) =>
        item.kind === 'file' &&
        (!item.type || /^image\/(png|jpeg|gif|webp|avif)$/.test(item.type)),
    )
  );
}

export function listenForFileDrop(
  show: (active: boolean) => void,
  upload: (files: File[]) => void,
) {
  let depth = 0;
  let internal = false;
  const reset = () => {
    depth = 0;
    internal = false;
    show(false);
  };
  const start = () => {
    internal = true;
  };
  const enter = (event: DragEvent) => {
    if (internal || !isFileDrag(event.dataTransfer)) return;
    depth++;
    if (!explicitTarget(event)) show(acceptsFileDrag(event.dataTransfer));
  };
  const leave = () => {
    if (depth > 0 && --depth === 0) show(false);
  };
  const over = (event: DragEvent) => {
    if (internal || !isFileDrag(event.dataTransfer) || explicitTarget(event))
      return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
  };
  const drop = (event: DragEvent) => {
    const local = internal;
    reset();
    if (local || !isFileDrag(event.dataTransfer) || explicitTarget(event))
      return;
    event.preventDefault();
    upload([...event.dataTransfer!.files]);
  };
  const visibility = () => {
    if (document.hidden) reset();
  };
  globalThis.addEventListener('dragenter', enter);
  globalThis.addEventListener('dragstart', start);
  globalThis.addEventListener('dragleave', leave);
  globalThis.addEventListener('dragover', over);
  globalThis.addEventListener('drop', drop);
  globalThis.addEventListener('dragend', reset);
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    globalThis.removeEventListener('dragenter', enter);
    globalThis.removeEventListener('dragstart', start);
    globalThis.removeEventListener('dragleave', leave);
    globalThis.removeEventListener('dragover', over);
    globalThis.removeEventListener('drop', drop);
    globalThis.removeEventListener('dragend', reset);
    window.removeEventListener('blur', reset);
    document.removeEventListener('visibilitychange', visibility);
  };
}
