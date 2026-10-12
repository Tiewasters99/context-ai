import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BookOpen, Plus, Upload, LogOut, Trash2, Sparkles, ChevronRight } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import PdfBook, { type PdfSource, type MarksStore, type BenchStore } from '@/components/reader/PdfBook';
import { renderPageCanvas, canvasToBlob } from '@/lib/pdf-page-image';
import type { MoreItem } from '@/components/reader/reader-chrome';
import {
  type Edition, type EditionRights,
  listMyEditions, listOwnedEditions, getEdition, createEdition, updateEdition, deleteEdition,
  uploadAsset, listAssets, coverUrl, publishEdition, editionSource, editionMarks, editionBench,
} from './editions';

// The Grapheon Reader (docs/specs/GRAPHEON-READER-2026-10-10.md). Phase 1,
// step 3: sign in, My Library, New edition (a PDF uploaded), the Reader
// with the bench on the maker's own draft, Publish to version 1. The Store,
// purchases, offline and creator payouts are later phases.
//
// Addressed at read.grapheon.ai (a host rewrite to edition.html, once the
// DNS record exists — D1) and, until then, under /reader on contextspaces.ai.
// Routes:  /            My Library (or sign in)
//          /new         New edition
//          /read/<id>   the Reader — with the Workshop when the edition is yours
//
// No accounts are made here: sign-ups are closed until 15 October (migration
// 090's reason), and the Reader shares Contextspaces' sign-in.

// ---------------------------------------------------------------------------
// Where we are
// ---------------------------------------------------------------------------

/** The path prefix this page is served under: '' at read.grapheon.ai, '/reader' on contextspaces.ai. */
const BASE = /^\/reader(\/|$)/.test(window.location.pathname) ? '/reader' : '';

type Route = { name: 'home' } | { name: 'new' } | { name: 'read'; id: string };

function parseRoute(pathname: string): Route {
  const p = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const m = p.match(/^\/read\/([^/?#]+)/);
  if (m) return { name: 'read', id: decodeURIComponent(m[1]) };
  if (/^\/new\/?$/.test(p)) return { name: 'new' };
  return { name: 'home' };
}

function useRoute(): [Route, (to: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, '', `${BASE}${to}`);
    setRoute(parseRoute(window.location.pathname));
  }, []);
  return [route, navigate];
}

function useSession(): { session: Session | null; ready: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { if (live) setSession(s); });
    return () => { live = false; sub.subscription.unsubscribe(); };
  }, []);
  return { session, ready };
}

// ---------------------------------------------------------------------------
// The look: a reading room, not a dashboard
// ---------------------------------------------------------------------------

const SERIF = "'Cormorant Garamond Variable', 'Cormorant Garamond', Georgia, serif";

function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-full" style={{ background: 'linear-gradient(180deg, #f4ecd8 0%, #e9dcbb 100%)', color: '#2b2315' }}>
      <div className={`mx-auto px-5 py-8 ${wide ? 'max-w-5xl' : 'max-w-xl'}`}>{children}</div>
    </div>
  );
}

function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 select-none">
      <span style={{ fontFamily: SERIF, fontWeight: 600, fontSize: small ? 22 : 34, letterSpacing: '0.01em' }}>Grapheon</span>
      <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: small ? 16 : 22, opacity: 0.75 }}>Reader</span>
    </div>
  );
}

const field =
  'w-full rounded-md border border-[#c9b98f] bg-[#fbf6ea] px-3 py-2 text-[15px] outline-none focus:border-[#8a6d2f] placeholder:text-[#a08f6a]';
const primary =
  'inline-flex items-center gap-2 rounded-md bg-[#2b2315] px-4 py-2 text-[14px] font-medium text-[#f4ecd8] hover:bg-[#3d3220] disabled:opacity-50';
const quiet =
  'inline-flex items-center gap-2 rounded-md border border-[#c9b98f] px-3 py-2 text-[14px] text-[#2b2315] hover:bg-[#f1e6c9] disabled:opacity-50';

function Trouble({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="rounded-md border border-[#c98a6a] bg-[#f7e2d6] px-3 py-2 text-[13px] text-[#6a2f1a]">{text}</p>;
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setTrouble(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setTrouble(error.message);
    setBusy(false);
  };

  return (
    <Shell>
      <div className="pt-10">
        <Wordmark />
        <p className="mt-3 text-[15px] leading-relaxed opacity-80" style={{ fontFamily: SERIF, fontSize: 18 }}>
          Books whose pages carry the clips and plates their passages call for.
          Sign in to read what is yours and to make an edition of your own.
        </p>
        <form onSubmit={submit} className="mt-8 space-y-3">
          <input className={field} type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className={field} type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Trouble text={trouble} />
          <button className={primary} type="submit" disabled={busy || !email || !password}>
            <BookOpen size={16} /> {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-6 text-[12px] opacity-60">
          A Contextspaces account is a reader account. New accounts open on 15 October.
        </p>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// My Library
// ---------------------------------------------------------------------------

function Cover({ edition }: { edition: Edition }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void coverUrl(edition).then((u) => { if (live) setUrl(u); }).catch(() => {});
    return () => { live = false; };
  }, [edition]);
  return (
    <div
      className="relative aspect-[2/3] w-full overflow-hidden rounded-sm shadow-[0_6px_18px_rgba(43,35,21,0.25)]"
      style={{ background: 'linear-gradient(160deg, #5b4a2a, #2b2315)' }}
    >
      {url ? (
        <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-3 text-center text-[#f4ecd8]">
          <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, lineHeight: 1.15 }}>{edition.title}</span>
          {edition.author && <span className="mt-2 text-[12px] opacity-75" style={{ fontFamily: SERIF, fontStyle: 'italic' }}>{edition.author}</span>}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ edition }: { edition: Edition }) {
  const text = edition.status === 'published' ? `Published · v${edition.version}`
    : edition.status === 'withdrawn' ? 'Withdrawn'
      : edition.version > 0 ? `Draft · v${edition.version} live` : 'Draft';
  return <span className="text-[11px] uppercase tracking-[0.12em] opacity-60">{text}</span>;
}

function Library({ session, navigate }: { session: Session; navigate: (to: string) => void }) {
  const [mine, setMine] = useState<Edition[] | null>(null);
  const [owned, setOwned] = useState<Edition[]>([]);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([listMyEditions(), listOwnedEditions()])
      .then(([m, o]) => { if (live) { setMine(m); setOwned(o); } })
      .catch((e: unknown) => {
        if (!live) return;
        setTrouble(e instanceof Error ? e.message : 'The library could not be read.');
        setMine([]);
      });
    return () => { live = false; };
  }, [tick]);

  const remove = async (ed: Edition) => {
    try {
      await deleteEdition(ed.id);
      setRemoving(null);
      setTick((t) => t + 1);
    } catch (e) {
      setTrouble(e instanceof Error ? e.message : 'The edition was not removed.');
    }
  };

  return (
    <Shell wide>
      <div className="flex items-end justify-between gap-4">
        <Wordmark />
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-[12px] opacity-60">{session.user.email}</span>
          <button className={quiet} onClick={() => void supabase.auth.signOut()} title="Sign out"><LogOut size={14} /></button>
        </div>
      </div>

      <div className="mt-8 flex items-baseline justify-between">
        <h2 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 600 }}>My Library</h2>
        <button className={primary} onClick={() => navigate('/new')}><Plus size={15} /> New edition</button>
      </div>
      <Trouble text={trouble} />

      {mine === null ? (
        <p className="mt-6 text-[14px] opacity-60">Opening the shelves…</p>
      ) : mine.length === 0 && owned.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-[#c9b98f] p-8 text-center">
          <Sparkles className="mx-auto opacity-50" size={22} />
          <p className="mt-3" style={{ fontFamily: SERIF, fontSize: 20 }}>Nothing on the shelf yet.</p>
          <p className="mt-1 text-[14px] opacity-70">Upload a PDF, lay a clip where its plate sits, and read it back.</p>
          <button className={`${primary} mt-5`} onClick={() => navigate('/new')}><Plus size={15} /> New edition</button>
        </div>
      ) : (
        <>
          {mine.length > 0 && (
            <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4">
              {mine.map((ed) => (
                <div key={ed.id} className="group">
                  <button className="block w-full text-left" onClick={() => navigate(`/read/${ed.id}`)}>
                    <Cover edition={ed} />
                    <div className="mt-2.5 leading-tight">
                      <div style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 600 }}>{ed.title}</div>
                      {ed.author && <div className="text-[13px] opacity-70">{ed.author}</div>}
                      <div className="mt-1"><StatusBadge edition={ed} /></div>
                    </div>
                  </button>
                  {ed.status === 'draft' && ed.version === 0 && (
                    removing === ed.id ? (
                      <div className="mt-2 flex items-center gap-2 text-[12px]">
                        <span>Remove this draft and its files?</span>
                        <button className="underline" onClick={() => void remove(ed)}>Yes</button>
                        <button className="underline opacity-60" onClick={() => setRemoving(null)}>No</button>
                      </div>
                    ) : (
                      <button
                        className="mt-2 inline-flex items-center gap-1 text-[12px] opacity-0 group-hover:opacity-60 hover:!opacity-100"
                        onClick={() => setRemoving(ed.id)}
                      >
                        <Trash2 size={12} /> Remove
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
          {owned.length > 0 && (
            <>
              <h3 className="mt-10" style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 600 }}>Bought</h3>
              <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4">
                {owned.map((ed) => (
                  <button key={ed.id} className="block text-left" onClick={() => navigate(`/read/${ed.id}`)}>
                    <Cover edition={ed} />
                    <div className="mt-2.5 leading-tight">
                      <div style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 600 }}>{ed.title}</div>
                      {ed.author && <div className="text-[13px] opacity-70">{ed.author}</div>}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// New edition: a PDF, a title, an author
// ---------------------------------------------------------------------------

function NewEdition({ navigate }: { navigate: (to: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pick = (f: File | null) => {
    setFile(f);
    if (f && !title.trim()) setTitle(f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim());
  };

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setTrouble(null);
    let edition: Edition | null = null;
    try {
      setBusy('Making the edition…');
      edition = await createEdition({ title, author: author || null });
      setBusy('Uploading the book…');
      setProgress(0);
      await uploadAsset(edition, 'book', file, {
        onProgress: ({ loaded, total }) => setProgress(total ? loaded / total : null),
      });
      navigate(`/read/${edition.id}`);
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : 'The edition could not be made.');
      // A draft with no book is nothing to keep.
      if (edition) await deleteEdition(edition.id).catch(() => {});
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <Shell>
      <button className="inline-flex items-center gap-1 text-[13px] opacity-70 hover:opacity-100" onClick={() => navigate('/')}>
        ← My Library
      </button>
      <h2 className="mt-4" style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 600 }}>New edition</h2>
      <p className="mt-1 text-[14px] opacity-70">
        A PDF — a facsimile of a public-domain book, or a book of your own. The Workshop opens beside it.
      </p>

      <form onSubmit={make} className="mt-6 space-y-4">
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center gap-3 rounded-lg border border-dashed border-[#a08f6a] bg-[#fbf6ea] px-4 py-5 text-left hover:bg-[#f7efdb]"
        >
          <Upload size={20} className="opacity-60" />
          <div className="min-w-0">
            <div className="text-[15px] font-medium truncate">{file ? file.name : 'Choose a PDF'}</div>
            <div className="text-[12px] opacity-60">{file ? `${(file.size / 1048576).toFixed(1)} MB` : 'Large scans upload in pieces and resume if the connection drops.'}</div>
          </div>
        </button>
        <input className={field} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className={field} placeholder="Author (as printed)" value={author} onChange={(e) => setAuthor(e.target.value)} />
        <Trouble text={trouble} />
        {busy && (
          <div>
            <div className="text-[13px] opacity-70">{busy}</div>
            {progress !== null && (
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-[#e3d4ad]">
                <div className="h-full bg-[#8a6d2f] transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        <button className={primary} type="submit" disabled={!file || !title.trim() || !!busy}>
          <ChevronRight size={15} /> Open in the Reader
        </button>
        {!busy && (!file || !title.trim()) && (
          <p className="text-[12px] opacity-60">
            {!file ? 'Choose the PDF first: tap the box above and pick it from your files.' : 'Give it a title.'}
          </p>
        )}
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Publish: rights, a word about it, a price; the jacket from page 1; version n+1
// ---------------------------------------------------------------------------

const RIGHTS: { value: EditionRights; label: string; hint: string }[] = [
  { value: 'public_domain', label: 'Public domain', hint: 'The text and plates are out of copyright. Name the edition year.' },
  { value: 'own', label: 'My own work', hint: 'The text, the pictures and the clips are yours, or made on a plan that allows commercial use.' },
  { value: 'licensed', label: 'Licensed', hint: 'Name the licensor.' },
];

/** The guard's sentence when the account has no active publisher row (112). */
const NO_PUBLISHER_ROW = 'This account cannot publish to the store yet.';

/** The one line that opens publishing for an account (D5: Eden makes these
 *  rows until Phase 4). Shown with the user's own id in it, ready to paste
 *  into the Supabase SQL editor — one trip, nothing to look up. */
function publisherRowSql(userId: string): string {
  return `insert into public.publisher_accounts (user_id, status)\nvalues ('${userId}', 'active')\non conflict (user_id) do update set status = 'active';`;
}

function PublishDialog({ edition, pdf, userId, onClose, onPublished }: {
  edition: Edition;
  pdf: PDFDocumentProxy | null;
  userId: string;
  onClose: () => void;
  onPublished: (e: Edition) => void;
}) {
  const [rights, setRights] = useState<EditionRights | null>(edition.rights);
  const [rightsNote, setRightsNote] = useState(edition.rights_note ?? '');
  const [description, setDescription] = useState(edition.description ?? '');
  const [price, setPrice] = useState((edition.price_cents / 100).toFixed(2));
  const [busy, setBusy] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const again = edition.version > 0;

  const publish = async () => {
    if (!rights) { setTrouble('Say whose the book is.'); return; }
    const cents = Math.round(Number(price.replace(/[^0-9.]/g, '')) * 100);
    if (!Number.isFinite(cents) || cents < 0) { setTrouble('The price is not a number.'); return; }
    setTrouble(null);
    try {
      setBusy('Keeping the details…');
      let cover_path = edition.cover_path;
      if (pdf && !cover_path) {
        setBusy('Taking the jacket from page 1…');
        const canvas = await renderPageCanvas(pdf, 1, { maxEdge: 1400 });
        const blob = await canvasToBlob(canvas, 'image/jpeg', 0.86);
        const asset = await uploadAsset(edition, 'cover', blob, { name: 'cover.jpg' });
        cover_path = asset.storage_path;
      }
      await updateEdition(edition.id, {
        rights, rights_note: rightsNote.trim() || null, description: description.trim() || null, price_cents: cents, cover_path,
      });
      setBusy(again ? 'Publishing the update…' : 'Publishing…');
      await publishEdition(edition.id);
      const fresh = await getEdition(edition.id);
      if (fresh) onPublished(fresh);
      onClose();
    } catch (e) {
      setTrouble(e instanceof Error ? e.message : 'It was not published.');
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-xl bg-[#f4ecd8] p-5 text-[#2b2315] shadow-2xl sm:max-w-lg sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 600 }}>{again ? 'Publish update' : 'Publish'}</h3>
        <p className="mt-1 text-[13px] opacity-70">
          {again
            ? `Version ${edition.version} is what readers have. This freezes version ${edition.version + 1}; readers get it free.`
            : 'Freezes version 1. Editing goes on underneath; a later Publish update freezes the next.'}
        </p>

        <div className="mt-4 space-y-2">
          <div className="text-[12px] uppercase tracking-[0.12em] opacity-60">Whose is it</div>
          {RIGHTS.map((r) => (
            <label key={r.value} className={`flex cursor-pointer gap-3 rounded-md border px-3 py-2 ${rights === r.value ? 'border-[#8a6d2f] bg-[#fbf6ea]' : 'border-[#c9b98f]'}`}>
              <input type="radio" name="rights" className="mt-1" checked={rights === r.value} onChange={() => setRights(r.value)} />
              <div>
                <div className="text-[14px] font-medium">{r.label}</div>
                <div className="text-[12px] opacity-70">{r.hint}</div>
              </div>
            </label>
          ))}
          <input className={field} placeholder={rights === 'licensed' ? 'Licensor' : rights === 'public_domain' ? 'Edition year, publisher' : 'A note, if any'} value={rightsNote} onChange={(e) => setRightsNote(e.target.value)} />
        </div>

        <div className="mt-4">
          <div className="text-[12px] uppercase tracking-[0.12em] opacity-60">About the edition</div>
          <textarea className={`${field} mt-1 min-h-[80px]`} placeholder="What a reader will find in it." value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="mt-4">
          <div className="text-[12px] uppercase tracking-[0.12em] opacity-60">Price (USD; 0 is free)</div>
          <input className={`${field} mt-1 w-32`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          <p className="mt-1 text-[12px] opacity-60">Sales open with the Store (Phase 2). A free edition is readable by anyone signed in.</p>
        </div>

        <Trouble text={trouble} />
        {trouble === NO_PUBLISHER_ROW && (
          <div className="mt-2 rounded-md border border-[#c9b98f] bg-[#fbf6ea] p-3 text-[12px]">
            <p className="opacity-80">Publishing is opened per account for now. Paste this in the Supabase SQL editor (Database → SQL Editor → New query → Run), then press Publish again:</p>
            <pre className="mt-2 overflow-x-auto whitespace-pre rounded bg-[#2b2315] p-2 text-[11px] text-[#f4ecd8]">{publisherRowSql(userId)}</pre>
            <button
              className={`${quiet} mt-2`}
              onClick={() => { void navigator.clipboard?.writeText(publisherRowSql(userId)); }}
            >
              Copy the SQL
            </button>
          </div>
        )}
        {busy && <p className="mt-3 text-[13px] opacity-70">{busy}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className={quiet} onClick={onClose} disabled={!!busy}>Not now</button>
          <button className={primary} onClick={() => void publish()} disabled={!!busy}>
            <Sparkles size={15} /> {again ? 'Publish update' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Reader
// ---------------------------------------------------------------------------

function Read({ id, session, navigate }: { id: string; session: Session; navigate: (to: string) => void }) {
  const [edition, setEdition] = useState<Edition | null | undefined>(undefined);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [reloadKey] = useState(0);

  // Keyed by the edition in EditionApp, so a new id is a fresh mount.
  useEffect(() => {
    let live = true;
    getEdition(id)
      .then(async (ed) => {
        if (!live) return;
        if (ed && ed.publisher_user_id === session.user.id) {
          // A draft whose upload never finished has no book: back to the shelf.
          const assets = await listAssets(ed.id);
          if (live && !assets.some((a) => a.kind === 'book')) {
            setTrouble('This edition has no book file yet.');
          }
        }
        if (live) setEdition(ed);
      })
      .catch((e: unknown) => { if (live) { setTrouble(e instanceof Error ? e.message : 'The edition could not be read.'); setEdition(null); } });
    return () => { live = false; };
  }, [id, session.user.id]);

  const mine = !!edition && edition.publisher_user_id === session.user.id;

  const source = useMemo<PdfSource | null>(() => (edition ? editionSource(edition, reloadKey, { canEdit: mine }) : null), [edition, reloadKey, mine]);
  const marks = useMemo<MarksStore | null>(() => (edition ? editionMarks(edition) : null), [edition]);
  const bench = useMemo<BenchStore | null>(() => (edition && mine ? editionBench(edition, true) : null), [edition, mine]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  if (edition === undefined) {
    return <Shell><p className="pt-10 text-[14px] opacity-60">Opening…</p></Shell>;
  }
  if (!edition) {
    return (
      <Shell>
        <button className="inline-flex items-center gap-1 text-[13px] opacity-70 hover:opacity-100" onClick={() => navigate('/')}>← My Library</button>
        <p className="mt-6" style={{ fontFamily: SERIF, fontSize: 22 }}>That edition is not on your shelf.</p>
        <Trouble text={trouble} />
      </Shell>
    );
  }

  const publishItem: MoreItem[] = mine ? [{ icon: <Sparkles size={14} />, label: edition.version > 0 ? 'Publish update' : 'Publish', run: () => setPublishing(true) }] : [];

  return (
    <div className="h-full">
      <PdfBook
        source={source}
        marks={marks}
        bench={bench}
        currentUserId={session.user.id}
        meta={{ title: edition.title, pageCount: null }}
        pageMemoryKey={`edition:${edition.id}`}
        onClose={() => navigate('/')}
        title={
          <span className="truncate text-[13px] text-white/80" style={{ fontFamily: SERIF, fontSize: 16 }}>
            {edition.title}{edition.author ? <span className="opacity-60"> · {edition.author}</span> : null}
          </span>
        }
        toolbarEnd={mine ? (
          <button
            onClick={() => setPublishing(true)}
            className="hidden sm:inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-white/80 hover:bg-white/5 hover:text-white"
            title={edition.version > 0 ? 'Publish update' : 'Publish this edition'}
          >
            <Sparkles size={14} /> {edition.version > 0 ? `Publish update (v${edition.version} live)` : 'Publish'}
          </button>
        ) : null}
        moreItems={publishItem}
        banners={notice ? (
          <div className="border-b border-[rgba(232,184,74,0.35)] bg-[rgba(232,184,74,0.10)] px-3 py-1.5 text-[12px] text-[#e8b84a]">{notice}</div>
        ) : trouble ? (
          <div className="border-b border-[rgba(201,138,106,0.4)] bg-[rgba(201,138,106,0.12)] px-3 py-1.5 text-[12px] text-[#f0b9a0]">{trouble}</div>
        ) : null}
        onOpened={(opened) => setPdf(opened)}
        onError={(e) => setTrouble(e instanceof Error ? e.message : 'The book could not be opened.')}
      />
      {publishing && (
        <PublishDialog
          edition={edition}
          pdf={pdf}
          userId={session.user.id}
          onClose={() => setPublishing(false)}
          onPublished={(fresh) => {
            setEdition(fresh);
            setNotice(`Published: version ${fresh.version}. Readers who own it get this version.`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function EditionApp() {
  const [route, navigate] = useRoute();
  const { session, ready } = useSession();

  useEffect(() => {
    document.title = route.name === 'read' ? 'Grapheon Reader' : 'My Library — Grapheon Reader';
  }, [route]);

  if (!ready) return <Shell><p className="pt-10 text-[14px] opacity-60">…</p></Shell>;
  if (!session) return <SignIn />;
  if (route.name === 'new') return <NewEdition navigate={navigate} />;
  if (route.name === 'read') return <Read key={route.id} id={route.id} session={session} navigate={navigate} />;
  return <Library session={session} navigate={navigate} />;
}
