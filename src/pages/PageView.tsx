import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Lock, Unlock, X, Download } from 'lucide-react';
import { pageToDocxBlob, downloadBlob, safeFilename } from '@/lib/export-page';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import CanvasPinToggle from '@/components/canvas/CanvasPinToggle';
import PinToggle from '@/components/ui/PinToggle';
import CoverModeToggle from '@/components/ui/CoverModeToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import type { EmbeddableViewProps } from '@/lib/canvas';
import { useCoverExpanded } from '@/hooks/useCoverExpanded';
import {
  useContentItem,
  updateContentItem,
  useContentInvalidate,
  type ContentItemFull,
} from '@/hooks/useContentItems';
import { RichTextEditor, normalizeBody } from '@/components/content/Editor';
import { useAuth } from '@/contexts/AuthContext';
import { useAutosave } from '@/hooks/useUnsavedGuard';
import { restoreOfferLine, saveStatusLine } from '@/lib/draft-store';

/** What is being autosaved: the whole page, so the last write wins cleanly. */
interface PageDraft {
  title: string;
  body: object;
}

export default function PageView({ id: propId, embedded = false, onClose }: EmbeddableViewProps = {}) {
  const params = useParams();
  const id = propId ?? params.id;
  const navigate = useNavigate();
  // Per-page geometry — see the matching note in ListView.
  const { cardRef, toggleFullscreen, pinned, togglePin, isMobile } = useDraggableResizable(
    embedded || !id ? undefined : `cs.pageview.card.${id}`,
    { boundToViewport: true },
  );
  const [coverExpanded, setCoverExpanded] = useCoverExpanded(id);
  const { data: item, isLoading, error } = useContentItem(id);
  const invalidate = useContentInvalidate();

  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [initialBody, setInitialBody] = useState<object | null>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);
  // The live document, read by every save. Refs, not state: a keystroke must
  // not re-render the page, and the debounced save needs the latest of both
  // halves whichever one changed.
  const draftRef = useRef<PageDraft>({ title: '', body: { type: 'doc' } });
  // Bumped to remount TipTap when a restored draft replaces its content:
  // `useEditor({ content })` applies once, at creation.
  const [editorRevision, setEditorRevision] = useState(0);
  const [draftHandled, setDraftHandled] = useState(false);

  useEffect(() => {
    hydrated.current = false;
    setInitialBody(null);
    setDraftHandled(false);
  }, [id]);

  // ONE writer for the page's own content, debounced while typing and flushed
  // on blur, on unmount, on a route change, when the tab is hidden and on
  // pagehide. Before this, everything typed since the last click-away died
  // with the tab (PR #192 §3).
  const autosave = useAutosave<PageDraft>({
    userId: user?.id,
    itemId: id,
    baseUpdatedAt: item?.updated_at ?? null,
    save: async (value) => {
      if (!id) return;
      await updateContentItem(id, {
        title: value.title || 'Untitled Page',
        content: { body: value.body },
      });
      invalidate.invalidateItem(id);
    },
  });
  const { change, adopt, flush } = autosave;

  useEffect(() => {
    if (!item || hydrated.current) return;
    setTitle(item.title);
    const body = normalizeBody(item.content?.body);
    setInitialBody(body);
    if (titleRef.current) titleRef.current.textContent = item.title;
    draftRef.current = { title: item.title, body };
    // This IS the server's copy: no save, and nothing marked dirty.
    adopt(draftRef.current);
    hydrated.current = true;
  }, [item, adopt]);

  // The unsaved copy on this computer, offered only when it actually differs
  // from what the server holds. A draft exists at all only because a save
  // never completed, so this never overwrites anything by itself.
  const localDraft = autosave.draft;
  const offerRestore =
    !draftHandled &&
    !!localDraft &&
    !!item &&
    JSON.stringify(localDraft.data.body) !== JSON.stringify(normalizeBody(item.content?.body));

  const restoreDraft = () => {
    if (!localDraft) return;
    setTitle(localDraft.data.title);
    setInitialBody(localDraft.data.body);
    if (titleRef.current) titleRef.current.textContent = localDraft.data.title;
    draftRef.current = { ...localDraft.data };
    setEditorRevision((n) => n + 1);
    setDraftHandled(true);
    change(draftRef.current);
  };

  const discardDraft = () => {
    autosave.discardDraft();
    setDraftHandled(true);
  };

  // Everything that is NOT the document — the lock, the cover — is a
  // deliberate click, so it flushes the document first and then writes its own
  // column. Two writes, never overlapping, never racing for the same field.
  const persist = async (patch: Partial<Pick<ContentItemFull, 'is_locked' | 'cover_url'>>) => {
    if (!id) return;
    await flush();
    try {
      await updateContentItem(id, patch);
      invalidate.invalidateItem(id);
    } catch (e) {
      console.error('save failed', e);
    }
  };

  const handleTitleInput = () => {
    const next = (titleRef.current?.textContent ?? '').trim();
    draftRef.current = { ...draftRef.current, title: next };
    change(draftRef.current);
  };

  const handleTitleBlur = () => {
    const next = (titleRef.current?.textContent ?? '').trim();
    setTitle(next);
    draftRef.current = { ...draftRef.current, title: next };
    change(draftRef.current);
    void flush();
  };

  const handleEditorChange = (json: object) => {
    draftRef.current = { ...draftRef.current, body: json };
    change(draftRef.current);
  };

  const handleEditorSave = (json: object) => {
    handleEditorChange(json);
    void flush();
  };

  const handleCoverChange = (url: string | null) => {
    void persist({ cover_url: url });
  };

  const toggleLock = () => {
    if (!item) return;
    void persist({ is_locked: !item.is_locked });
  };

  const [exportingKind, setExportingKind] = useState<'docx' | null>(null);
  const exportDocx = async () => {
    if (!item || exportingKind) return;
    setExportingKind('docx');
    try {
      const blob = await pageToDocxBlob(item.content?.body, item.title);
      downloadBlob(blob, safeFilename(item.title, '.docx'));
    } catch (e) {
      console.error('export to .docx failed', e);
    } finally {
      setExportingKind(null);
    }
  };

  const isLocked = item?.is_locked ?? false;

  const body = (
    <>
        {error && (
          <p className="text-[13px] text-red-300 py-12 text-center">
            {error instanceof Error ? error.message : 'Failed to load page'}
          </p>
        )}

        {!error && isLoading && (
          <p className="text-[13px] text-white/40 py-12 text-center">Loading…</p>
        )}

        {!error && !isLoading && !item && (
          <p className="text-[13px] text-white/40 py-12 text-center">Page not found.</p>
        )}

        {item && offerRestore && localDraft && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[#e8b84a]/30 bg-[rgba(232,184,74,0.08)] px-3 py-2 text-[13px] text-[#f5f1e8]">
            <span className="flex-1 min-w-[12rem]">
              {restoreOfferLine(localDraft.savedAt, item.updated_at)}
            </span>
            <button
              onClick={restoreDraft}
              className="px-2.5 py-1 rounded-md bg-[#e8b84a]/20 text-[#e8b84a] hover:bg-[#e8b84a]/30 transition-colors"
            >
              Restore
            </button>
            <button
              onClick={discardDraft}
              className="px-2.5 py-1 rounded-md text-white/60 hover:text-white hover:bg-[rgba(255,255,255,0.08)] transition-colors"
            >
              Discard
            </button>
          </div>
        )}

        {item && initialBody && (
          <div className="flex flex-col-reverse md:flex-row gap-8">
            <div className="flex-1 min-w-0">
              <div
                ref={titleRef}
                contentEditable={!isLocked}
                suppressContentEditableWarning
                onInput={handleTitleInput}
                onBlur={handleTitleBlur}
                className="text-3xl font-bold text-[#f5f2ed] outline-none mb-6 empty:before:content-['Untitled'] empty:before:text-white/30"
                data-placeholder="Untitled"
              />
              <RichTextEditor
                key={editorRevision}
                initialContent={initialBody}
                editable={!isLocked}
                onChange={handleEditorChange}
                onSave={handleEditorSave}
              />
            </div>

            <div className="w-full md:w-56 shrink-0">
              <div className="md:sticky md:top-8 space-y-6">
                <button
                  onClick={toggleLock}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full ${
                    isLocked
                      ? 'bg-[#d4a054]/10 text-[#d4a054] hover:bg-[#d4a054]/15'
                      : 'bg-[#1c1c26] text-white/80 hover:bg-[#22222e]'
                  }`}
                >
                  {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
                  {isLocked ? 'Locked' : 'Unlocked'}
                </button>

                <div className="space-y-2 text-xs text-white/60">
                  <div className="flex justify-between">
                    <span>Created</span>
                    <span className="text-[#f5f1e8]">
                      {new Date(item.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Modified</span>
                    <span className="text-[#f5f1e8]">
                      {new Date(item.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span>Status</span>
                    {/* "Saving… / Saved 12:04", and when a write fails it says
                        so plainly rather than looking saved. */}
                    <span
                      className={
                        autosave.status.error
                          ? 'text-[#c96852]'
                          : isLocked
                            ? 'text-[#d4a054]'
                            : 'text-[#4ade80]'
                      }
                    >
                      {saveStatusLine(autosave.status) ?? (isLocked ? 'Locked' : 'Editable')}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
    </>
  );

  if (embedded) {
    return <div className="px-4 py-3">{body}</div>;
  }

  return (
    <div>
      <CoverImage
        coverUrl={item?.cover_url ?? null}
        onCoverChange={handleCoverChange}
        editable={!isLocked}
        expanded={coverExpanded}
        onExpandChange={setCoverExpanded}
        persistKey={id ? `cs.cover.${id}` : undefined}
        inherit
        matterId={item?.space_type === 'matterspace' ? item.space_id : null}
      />

      <div ref={cardRef} className={`max-w-4xl mx-auto rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 ${isMobile ? 'px-4 py-6' : 'px-8 pt-0 pb-8 cursor-grab select-none'}`} style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
        {/* Close + drag handle + Pin (fix in place) + Keep open + fullscreen */}
        <div className="md:sticky md:top-0 z-20 flex items-center justify-between -mx-4 px-4 pt-0 md:-mx-8 md:px-8 md:pt-6 pb-3 mb-4 rounded-t-xl border-b border-[rgba(255,255,255,0.08)] bg-[rgba(10,10,18,0.95)] backdrop-blur-[30px]">
          <button
            onClick={() => (onClose ? onClose() : navigate(-1))}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Back"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className={`w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors ${isMobile ? 'invisible' : ''}`} title="Drag to move" />
          <div className="flex items-center gap-1">
            <button
              onClick={exportDocx}
              disabled={!item || exportingKind === 'docx'}
              className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={exportingKind === 'docx' ? 'Exporting…' : 'Download as Word (.docx)'}
            >
              <Download size={14} strokeWidth={2} />
            </button>
            <CoverModeToggle hasCover={!!item?.cover_url} expanded={coverExpanded} onToggle={() => setCoverExpanded(!coverExpanded)} />
            {/* Pin sits next to Keep open so the two read as the pair they
                are. Not in a panel (the panel owns its own geometry) and not
                on a phone, where the card does not float at all. */}
            {!embedded && !isMobile && <PinToggle pinned={pinned} onToggle={togglePin} />}
            <CanvasPinToggle kind="page" id={id} title={title || item?.title || 'Untitled Page'} />
            <FullscreenToggle onToggle={toggleFullscreen} />
          </div>
        </div>

        {body}
      </div>
    </div>
  );
}
