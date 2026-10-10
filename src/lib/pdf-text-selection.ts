// Keeps a drag across a PDF's text layer to the words the mouse crosses.
//
// The text layer is a field of absolutely positioned spans with gaps between
// them. When a drag's end point falls in a gap, the browser extends the
// selection to the nearest text in document order — often a span far down
// the page — so two lines become ten. pdf.js's own viewer
// (web/text_layer_builder.js, TextLayerBuilder.#bindMouse and
// #enableGlobalSelectionListener) solves this with an "end of content"
// element: an empty, unselectable div that covers the whole layer while a
// selection is in progress (z-index 0, beneath the spans), and is moved in
// the DOM to sit just after the span the selection currently ends in, so a
// gap resolves to it and the selection stops where the mouse is. This is
// that mechanism, lifted for a text layer rendered with pdfjs.TextLayer
// directly, which never gets a builder.
//
// CSS this relies on (DocumentReader's ReaderStyle):
//   .textLayer .endOfContent { display:block; position:absolute; inset:100% 0 0; z-index:0; cursor:default; user-select:none; }
//   .textLayer.selecting .endOfContent { top:0; }

const layers = new Map<HTMLElement, HTMLElement>();
let globalAbort: AbortController | null = null;

function reset(end: HTMLElement, layer: HTMLElement) {
  layer.append(end);
  end.style.width = '';
  end.style.height = '';
  layer.classList.remove('selecting');
}

function enableGlobalListener() {
  if (globalAbort) return;
  globalAbort = new AbortController();
  const { signal } = globalAbort;
  let isPointerDown = false;
  const resetAll = () => layers.forEach(reset);
  document.addEventListener('pointerdown', () => { isPointerDown = true; }, { signal });
  document.addEventListener('pointerup', () => { isPointerDown = false; resetAll(); }, { signal });
  window.addEventListener('blur', () => { isPointerDown = false; resetAll(); }, { signal });
  document.addEventListener('keyup', () => { if (!isPointerDown) resetAll(); }, { signal });

  let isFirefox: boolean | undefined;
  let prevRange: Range | null = null;
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) { resetAll(); return; }

    const active = new Set<HTMLElement>();
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      for (const layer of layers.keys()) {
        if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
      }
    }
    for (const [layer, end] of layers) {
      if (active.has(layer)) layer.classList.add('selecting');
      else reset(end, layer);
    }
    if (active.size === 0) return;

    // Firefox honours user-select:none on the end div without the DOM move.
    isFirefox ??= getComputedStyle(layers.values().next().value as HTMLElement).getPropertyValue('-moz-user-select') === 'none';
    if (isFirefox) return;

    const range = selection.getRangeAt(0);
    const modifyStart = !!prevRange && (
      range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
      range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0
    );
    let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0 && anchor) {
      // The selection ends at the very start of a node: the span that
      // matters is the previous one with content.
      do {
        while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor?.previousSibling ?? null;
      } while (anchor && !anchor.childNodes.length);
    }
    const anchorEl = anchor as Element | null;
    const layer = anchorEl?.parentElement?.closest<HTMLElement>('.textLayer') ?? null;
    const end = layer ? layers.get(layer) : undefined;
    if (layer && end && anchorEl?.parentElement) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      end.style.userSelect = 'text';
      anchorEl.parentElement.insertBefore(end, modifyStart ? anchorEl : anchorEl.nextSibling);
    }
    prevRange = range.cloneRange();
  }, { signal });
}

const teardowns = new Map<HTMLElement, () => void>();

/** Call after pdfjs.TextLayer has rendered into `layer`. Safe to call again
 *  after a re-render (the old guard is replaced). */
export function guardTextLayerSelection(layer: HTMLElement): void {
  teardowns.get(layer)?.();
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.append(end);
  const onDown = () => layer.classList.add('selecting');
  layer.addEventListener('mousedown', onDown);
  layers.set(layer, end);
  enableGlobalListener();
  teardowns.set(layer, () => {
    layer.removeEventListener('mousedown', onDown);
    end.remove();
    layers.delete(layer);
    teardowns.delete(layer);
    if (layers.size === 0) { globalAbort?.abort(); globalAbort = null; }
  });
}

/** Drop every guard (the document is closing or its layers are rebuilt). */
export function releaseTextLayerGuards(): void {
  for (const t of Array.from(teardowns.values())) t();
}
