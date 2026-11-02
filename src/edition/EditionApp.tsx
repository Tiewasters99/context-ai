import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BookOpen, Plus, Upload, LogOut, Trash2, Sparkles, ChevronRight, Library as LibraryIcon, Search, Shirt } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import MerchSheet, { type MerchSheetOpen } from '@/components/reader/MerchSheet';
import { readMerchReturn, stripMerchReturn } from '@/lib/merch-sheet';
import PdfBook, { type PdfSource, type MarksStore, type BenchStore } from '@/components/reader/PdfBook';
import { renderPageCanvas, canvasToBlob } from '@/lib/pdf-page-image';
import type { MoreItem } from '@/components/reader/reader-chrome';
import {
  type Edition, type EditionRights,
  type LibraryBook,
  listVisibleEditions, listOwnedEditions, getEdition, createEdition, updateEdition, deleteEdition,
  uploadAsset, listAssets, coverUrl, publishEdition, editionSource, editionMarks, editionBench,
  listLibraryPdfs, copyBookFromDocument,
} from './editions';
import { type Week, type Block, type Inline, loadWeeklyIndex, loadWeekly, parseMarkdown, teaserOf, filedOn } from './weekly';

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
// The Reader shares Contextspaces' accounts: the cover signs a reader in with
// email + password, or makes an account the same way the main app does.

// ---------------------------------------------------------------------------
// Where we are
// ---------------------------------------------------------------------------

/** The path prefix this page is served under: '' at read.grapheon.ai, '/reader' on contextspaces.ai. */
const BASE = /^\/reader(\/|$)/.test(window.location.pathname) ? '/reader' : '';

type Route = { name: 'home' } | { name: 'new' } | { name: 'how' } | { name: 'weekly'; date: string | null } | { name: 'read'; id: string };

function parseRoute(pathname: string): Route {
  const p = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const m = p.match(/^\/read\/([^/?#]+)/);
  if (m) return { name: 'read', id: decodeURIComponent(m[1]) };
  if (/^\/new\/?$/.test(p)) return { name: 'new' };
  if (/^\/how\/?$/.test(p)) return { name: 'how' };
  const w = /^\/weekly(?:\/(\d{4}-\d{2}-\d{2}))?\/?$/.exec(p);
  if (w) return { name: 'weekly', date: w[1] ?? null };
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

const COVER = '/reader-cover-peacock.jpg';
const COVER_SOFT = '/reader-cover-peacock-blur.jpg';
const GOLD = '#d9bd7a';
const CLOTH = '#1b1a15';
const COVER_ASPECT = '513 / 793';
/** Where the title lettering was on the 1894 cover, as fractions of the picture. */
const TITLE_BLOCK = { left: '29%', top: '56%', width: '60%', height: '40%' };

const goldField =
  'w-full rounded-md border px-3 py-2 text-[15px] outline-none placeholder:text-[#9b8a5e] focus:border-[#f0d890]';
const goldFieldStyle = { borderColor: 'rgba(217,189,122,0.5)', background: 'rgba(8,8,6,0.5)', color: '#f1e3b8' } as const;
const goldPrimary =
  'inline-flex items-center gap-2 rounded-md px-4 py-2 text-[14px] font-medium disabled:opacity-50';

function useWideCover() {
  const q = '(min-width: 640px) and (min-height: 700px)';
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

function CoverMark({ wide, scale = 1 }: { wide: boolean; scale?: number }) {
  return (
    <div className="select-none text-center" style={{ fontFamily: SERIF, color: GOLD, lineHeight: 1 }}>
      <div style={{ fontWeight: 600, fontSize: (wide ? 46 : 36) * scale, letterSpacing: '0.02em' }}>Grapheon</div>
      <div style={{ fontStyle: 'italic', fontSize: (wide ? 26 : 20) * scale, opacity: 0.9, marginTop: 6 * scale }}>Reader</div>
    </div>
  );
}

/** On a phone the cover takes whatever height the fields leave, never more:
 *  the whole page fits the screen from the first paint, with no scrolling.
 *  Returns the cover's width for that height (capped by the screen width). */
function useCoverFit(active: boolean): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      setWidth(Math.max(0, Math.min(r.width, r.height * (513 / 793))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('orientationchange', fit);
    return () => { ro.disconnect(); window.removeEventListener('orientationchange', fit); };
  }, [active]);
  return [ref, width];
}

/**
 * The cover: Hugh Thomson's gilt peacock from the 1894 Pride and Prejudice
 * (public domain), its title lettering cleared. The Reader's mark and the
 * sign-in sit where that lettering was. On a wide screen the whole cover
 * stands at full height with the form inside the title block; on a phone the
 * cover spans the width, the mark and the line take the title block, and the
 * fields follow on the cloth beneath.
 */
function SignIn() {
  const wide = useWideCover();
  const [fitRef, coverW] = useCoverFit(!wide);
  const k = coverW ? Math.min(1.15, Math.max(0.6, coverW / 390)) : 1;
  const [mode, setMode] = useState<'in' | 'new'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setTrouble(null);
    setNote(null);
    const address = email.trim();
    if (mode === 'in') {
      const { error } = await supabase.auth.signInWithPassword({ email: address, password });
      if (error) setTrouble(error.message);
    } else {
      // Same shape as the Contextspaces sign-up (AuthContext.signUpWithEmail): the
      // profile trigger reads display_name from the metadata and falls back to the
      // local part of the address. The confirmation link lands back on the Reader
      // when /reader is among the allowed redirect URLs in Supabase Auth.
      const { data, error } = await supabase.auth.signUp({
        email: address,
        password,
        options: {
          data: { display_name: address.split('@')[0] },
          emailRedirectTo: `${window.location.origin}${BASE || '/reader'}`,
        },
      });
      if (error) setTrouble(error.message);
      else if (!data.session) {
        setNote('Check your email and open the confirmation link. Then come back here and sign in with your password.');
        setMode('in');
        setPassword('');
      }
      // With a session returned (confirmation off) the auth listener signs the reader in.
    }
    setBusy(false);
  };

  const swap = () => { setMode(mode === 'in' ? 'new' : 'in'); setTrouble(null); setNote(null); };

  const line = (
    <p className="text-center leading-snug" style={{ fontFamily: SERIF, color: 'rgba(233,214,160,0.92)', fontSize: wide ? 17 : 15 * k }}>
      Your customizable library, built and curated for you by the editors at Grapheon.ai. Sign in to begin exploring.
    </p>
  );

  const form = (
    <form onSubmit={submit} className="space-y-2.5">
      <input className={goldField} style={goldFieldStyle} type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className={goldField} style={goldFieldStyle} type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} placeholder={mode === 'in' ? 'Password' : 'Choose a password'} value={password} onChange={(e) => setPassword(e.target.value)} />
      <Trouble text={trouble} />
      {note && <p className="rounded-md border px-3 py-2 text-[13px]" style={{ borderColor: 'rgba(217,189,122,0.5)', color: '#f1e3b8' }}>{note}</p>}
      <div className="flex items-center justify-between gap-3 pt-1">
        <button className={goldPrimary} style={{ background: GOLD, color: CLOTH }} type="submit" disabled={busy || !email || !password}>
          <BookOpen size={16} /> {busy ? (mode === 'in' ? 'Signing in…' : 'Creating…') : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
        <button type="button" onClick={swap} className="text-[13px] underline underline-offset-2" style={{ color: GOLD }}>
          {mode === 'in' ? 'Create an account' : 'I have an account'}
        </button>
      </div>
      {mode === 'new' && (
        <p className="pt-1 text-[12px] leading-relaxed" style={{ color: 'rgba(233,214,160,0.7)' }}>
          By creating an account you accept the{' '}
          <a href="https://www.equazia.ai/terms" className="underline underline-offset-2">Terms of Service</a> and the{' '}
          <a href="https://www.equazia.ai/privacy" className="underline underline-offset-2">Privacy</a> page.
        </p>
      )}
    </form>
  );

  const alt = 'The gilt peacock of the 1894 Pride and Prejudice cover, drawn by Hugh Thomson';

  if (wide) {
    return (
      <div className="relative min-h-[100dvh] overflow-hidden" style={{ background: CLOTH }}>
        <img src={COVER_SOFT} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" style={{ filter: 'blur(26px) brightness(0.5)', transform: 'scale(1.15)' }} />
        <div className="relative mx-auto h-[100dvh]" style={{ aspectRatio: COVER_ASPECT, boxShadow: '0 0 80px rgba(0,0,0,0.6)' }}>
          <img src={COVER} alt={alt} className="absolute inset-0 h-full w-full" />
          <div className="absolute flex flex-col justify-center gap-4 px-3" style={TITLE_BLOCK}>
            <CoverMark wide />
            {line}
            {form}
          </div>
        </div>
      </div>
    );
  }

  // Phone: one screen, no scrolling. The fields keep their natural height at
  // the foot; the cover takes the rest, scaled to fit, with the mark and the
  // line scaled with it.
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden" style={{ background: CLOTH }}>
      <div ref={fitRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        <div className="relative" style={{ width: coverW ? `${coverW}px` : '100%', maxWidth: '100%', aspectRatio: COVER_ASPECT }}>
          <img src={COVER} alt={alt} className="absolute inset-0 h-full w-full" />
          <div className="absolute flex flex-col justify-center px-1" style={{ ...TITLE_BLOCK, gap: 10 * k }}>
            <CoverMark wide={false} scale={k} />
            {line}
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-[480px] px-5 pt-3" style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}>{form}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My Library
// ---------------------------------------------------------------------------

/** Only a few covers are signed at once; the rest wait for their turn and for the viewport. */
const COVER_SIGN_LIMIT = 6;
let coverSigning = 0;
const coverQueue: Array<() => void> = [];
function signCoverSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const go = () => { coverSigning += 1; resolve(() => { coverSigning -= 1; coverQueue.shift()?.(); }); };
    if (coverSigning < COVER_SIGN_LIMIT) go(); else coverQueue.push(go);
  });
}

function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (!('IntersectionObserver' in window)) { setSeen(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** A jacket on the shelf: the title and author on cloth until the cover file
 *  scrolls near, then the signed cover. The signing is paced so a shelf of
 *  four hundred books does not ask for four hundred URLs at once. */
function Cover({ edition }: { edition: Edition }) {
  const [url, setUrl] = useState<string | null>(null);
  const [ref, near] = useInView<HTMLDivElement>();
  useEffect(() => {
    if (!near || !edition.cover_path) return;
    let live = true;
    let release: (() => void) | null = null;
    void signCoverSlot()
      .then((r) => { release = r; return live ? coverUrl(edition) : null; })
      .then((u) => { if (live && u) setUrl(u); })
      .catch(() => {})
      .finally(() => release?.());
    return () => { live = false; };
  }, [edition, near]);
  return (
    <div
      ref={ref}
      className="relative aspect-[2/3] w-full overflow-hidden rounded-[2px]"
      style={{ background: 'linear-gradient(160deg, #3a3528, #1f1c14)', boxShadow: '0 8px 22px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(217,189,122,0.28)' }}
    >
      {url ? (
        <img src={url} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-3 text-center" style={{ color: 'rgba(233,214,160,0.9)' }}>
          <span style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 600, lineHeight: 1.15 }}>{edition.title}</span>
          {edition.author && <span className="mt-2 text-[11px] opacity-75" style={{ fontFamily: SERIF, fontStyle: 'italic' }}>{edition.author}</span>}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ edition }: { edition: Edition }) {
  const text = edition.status === 'published' ? `Published · v${edition.version}`
    : edition.status === 'withdrawn' ? 'Withdrawn'
      : edition.version > 0 ? `Draft · v${edition.version} live` : 'Draft';
  return <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'rgba(217,189,122,0.6)' }}>{text}</span>;
}

// ---------------------------------------------------------------------------
// The second page: the Library, in the cover's cloth and gilt
// ---------------------------------------------------------------------------

const SHELVES = ['Literature', 'History', 'Law', 'Science'] as const;
type Shelf = (typeof SHELVES)[number];

/** The Library shelf a mirrored book came from. The mirror writes it into the
 *  rights note ("filed in the Library (Law)"); a `shelf` column would be the
 *  durable home for it. */
function shelfOf(ed: Edition): Shelf | 'Library' | null {
  if (ed.access !== 'library') return null;
  const m = /filed in the Library \((Literature|History|Law|Science)\)/.exec(ed.rights_note ?? '');
  return (m?.[1] as Shelf | undefined) ?? 'Library';
}

/** Volumes of one set stay together and in order; everything else by title. */
function byShelfOrder(a: Edition, b: Edition): number {
  const ka = a.collection_key ?? a.title;
  const kb = b.collection_key ?? b.title;
  const c = ka.localeCompare(kb, 'en', { sensitivity: 'base' });
  if (c !== 0) return c;
  return (a.volume ?? 0) - (b.volume ?? 0);
}

const MANIFESTO =
  'The Grapheon Reader is a revolutionary approach to online publishing. Starting from our curated library of public domain works, personally selected by our founder, a summa cum laude comparative literature graduate of Yale University, customize any work with images and videos and, if the spirit moves you, create products with our seamless connection to your online store. The library is constantly updated with tasteful works of history, literature, science and law, spanning English, American, French, Spanish, Italian, German, and Asian traditions, regularly delivered to your Reader, together with a weekly summary of new editions, scholarly essays, and links to physical purchase options. Our aim is to enable rediscovery, recreation and regeneration of our global literary past—and breathe new life into the almost forgotten art of reading, by combining cutting edge technology with a timeless past.';

const goldQuiet =
  'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] disabled:opacity-50';
const goldQuietStyle = { borderColor: 'rgba(217,189,122,0.45)', color: GOLD } as const;

/** Two gilt hairlines, as on the cover's rules. */
function GiltRule({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden className={className}>
      <div style={{ height: 1, background: 'rgba(217,189,122,0.7)' }} />
      <div style={{ height: 1, marginTop: 3, background: 'rgba(217,189,122,0.35)' }} />
    </div>
  );
}

function GiltWordmark() {
  return (
    <div className="flex items-baseline gap-2 select-none" style={{ color: GOLD }}>
      <span style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 28, letterSpacing: '0.02em' }}>Grapheon</span>
      <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 18, opacity: 0.85 }}>Reader</span>
    </div>
  );
}

function ClothPage({ session, navigate, children }: { session: Session | null; navigate: (to: string) => void; children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh]" style={{ background: `radial-gradient(120% 60% at 50% 0%, #2a2719 0%, ${CLOTH} 60%)`, color: '#f1e3b8' }}>
      <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
        <div className="flex items-end justify-between gap-4">
          <button className="text-left" onClick={() => navigate('/')}><GiltWordmark /></button>
          {session ? (
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline text-[12px]" style={{ color: 'rgba(233,214,160,0.55)' }}>{session.user.email}</span>
              <button className={goldPrimary} style={{ background: GOLD, color: CLOTH }} onClick={() => navigate('/new')}><Plus size={15} /> New edition</button>
              <button className={goldQuiet} style={goldQuietStyle} onClick={() => void supabase.auth.signOut()} title="Sign out"><LogOut size={14} /></button>
            </div>
          ) : (
            <button className={goldPrimary} style={{ background: GOLD, color: CLOTH }} onClick={() => navigate('/')}><BookOpen size={15} /> Sign in</button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function ShelfHeading({ title, count }: { title: string; count: number }) {
  return (
    <div className="mt-12 mb-5">
      <div className="flex items-baseline gap-3">
        <h2 style={{ fontFamily: SERIF, fontSize: 32, fontWeight: 600, color: GOLD, lineHeight: 1 }}>{title}</h2>
        <span className="text-[11px] uppercase tracking-[0.18em]" style={{ color: 'rgba(217,189,122,0.6)' }}>{count} {count === 1 ? 'work' : 'works'}</span>
      </div>
      <GiltRule className="mt-3" />
    </div>
  );
}

function BookCard({ edition, navigate, onRemove }: { edition: Edition; navigate: (to: string) => void; onRemove?: () => void }) {
  return (
    <div className="group">
      <button className="block w-full text-left" onClick={() => navigate(`/read/${edition.id}`)}>
        <Cover edition={edition} />
        <div className="mt-2.5 leading-tight">
          <div style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 600, color: '#f1e3b8' }}>{edition.title}</div>
          {edition.author && <div className="mt-0.5 text-[12px]" style={{ color: 'rgba(233,214,160,0.7)', fontFamily: SERIF, fontStyle: 'italic' }}>{edition.author}</div>}
          {edition.access !== 'library' && <div className="mt-1"><StatusBadge edition={edition} /></div>}
        </div>
      </button>
      {onRemove && (
        <button
          className="mt-2 inline-flex items-center gap-1 text-[12px] opacity-0 group-hover:opacity-70 hover:!opacity-100"
          style={{ color: GOLD }}
          onClick={onRemove}
        >
          <Trash2 size={12} /> Remove
        </button>
      )}
    </div>
  );
}

function Library({ session, navigate }: { session: Session; navigate: (to: string) => void }) {
  const [all, setAll] = useState<Edition[] | null>(null);
  const [owned, setOwned] = useState<Edition[]>([]);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Edition | null>(null);
  const [tick, setTick] = useState(0);
  const [week, setWeek] = useState<Week | null>(null);

  useEffect(() => {
    let live = true;
    void loadWeeklyIndex().then((ws) => { if (live) setWeek(ws[0] ?? null); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([listVisibleEditions(), listOwnedEditions()])
      .then(([v, o]) => { if (live) { setAll(v); setOwned(o); } })
      .catch((e: unknown) => {
        if (!live) return;
        setTrouble(e instanceof Error ? e.message : 'The library could not be read.');
        setAll([]);
      });
    return () => { live = false; };
  }, [tick]);

  const uid = session.user.id;
  const shelves = useMemo(() => {
    const m = new Map<string, Edition[]>();
    for (const ed of all ?? []) {
      const shelf = shelfOf(ed);
      if (!shelf) continue;
      (m.get(shelf) ?? m.set(shelf, []).get(shelf)!).push(ed);
    }
    for (const list of m.values()) list.sort(byShelfOrder);
    return m;
  }, [all]);
  const mine = useMemo(() => (all ?? []).filter((ed) => ed.publisher_user_id === uid && ed.access !== 'library').sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [all, uid]);
  const fresh = useMemo(() => {
    if (!week) return [];
    return (all ?? [])
      .filter((ed) => { const d = filedOn(ed.rights_note); return ed.access === 'library' && !!d && d >= week.from && d <= week.to; })
      .sort(byShelfOrder);
  }, [all, week]);
  const ownedIds = new Set(owned.map((e) => e.id));

  const remove = async (ed: Edition) => {
    try {
      await deleteEdition(ed.id);
      setRemoving(null);
      setTick((t) => t + 1);
    } catch (e) {
      setTrouble(e instanceof Error ? e.message : 'The edition was not removed.');
    }
  };

  const shelfOrder: string[] = [...SHELVES, 'Library'];
  const anyShelf = shelfOrder.some((k) => (shelves.get(k)?.length ?? 0) > 0);
  const grid = 'grid grid-cols-3 gap-x-4 gap-y-7 sm:grid-cols-4 md:grid-cols-6';

  return (
    <ClothPage session={session} navigate={navigate}>
      <GiltRule className="mt-7" />
      <div className="mx-auto max-w-3xl py-9 text-center">
        <p
          className="text-left first-letter:float-left first-letter:mr-2 first-letter:text-[64px] first-letter:leading-[0.8] first-letter:font-semibold"
          style={{ fontFamily: SERIF, fontSize: 19, lineHeight: 1.55, color: 'rgba(241,227,184,0.94)' }}
        >
          {MANIFESTO}
        </p>
      </div>
      <GiltRule />
      {week && <WeeklyCard week={week} navigate={navigate} />}
      {fresh.length > 0 && (
        <section>
          <ShelfHeading title="New this week" count={fresh.length} />
          <div className={grid}>
            {fresh.map((ed) => <BookCard key={ed.id} edition={ed} navigate={navigate} />)}
          </div>
        </section>
      )}
      {SPOTLIGHT.work && <SpotlightCard navigate={navigate} />}
      <Trouble text={trouble} />

      {all === null ? (
        <p className="mt-8 text-[14px]" style={{ color: 'rgba(233,214,160,0.6)' }}>Opening the shelves…</p>
      ) : (
        <>
          {shelfOrder.map((k) => {
            const list = shelves.get(k);
            if (!list || list.length === 0) return null;
            return (
              <section key={k}>
                <ShelfHeading title={k} count={list.length} />
                <div className={grid}>
                  {list.map((ed) => <BookCard key={ed.id} edition={ed} navigate={navigate} />)}
                </div>
              </section>
            );
          })}

          {mine.length > 0 && (
            <section>
              <ShelfHeading title="My editions" count={mine.length} />
              <div className={grid}>
                {mine.map((ed) => (
                  <div key={ed.id}>
                    <BookCard
                      edition={ed}
                      navigate={navigate}
                      onRemove={ed.status === 'draft' && ed.version === 0 ? () => setRemoving(ed) : undefined}
                    />
                    {removing?.id === ed.id && (
                      <div className="mt-2 flex items-center gap-2 text-[12px]" style={{ color: GOLD }}>
                        <span>Remove this draft and its files?</span>
                        <button className="underline" onClick={() => void remove(ed)}>Yes</button>
                        <button className="underline opacity-60" onClick={() => setRemoving(null)}>No</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {owned.length > 0 && (
            <section>
              <ShelfHeading title="Bought" count={owned.length} />
              <div className={grid}>
                {owned.filter((ed) => ownedIds.has(ed.id)).map((ed) => <BookCard key={ed.id} edition={ed} navigate={navigate} />)}
              </div>
            </section>
          )}

          {!anyShelf && mine.length === 0 && owned.length === 0 && (
            <div className="mt-10 rounded-lg border border-dashed p-8 text-center" style={{ borderColor: 'rgba(217,189,122,0.4)' }}>
              <Sparkles className="mx-auto" size={22} style={{ color: GOLD }} />
              <p className="mt-3" style={{ fontFamily: SERIF, fontSize: 20, color: GOLD }}>The shelves are being filled.</p>
              <p className="mt-1 text-[14px]" style={{ color: 'rgba(233,214,160,0.7)' }}>Or start an edition of your own: a PDF, a title, an author.</p>
              <button className={`${goldPrimary} mt-5`} style={{ background: GOLD, color: CLOTH }} onClick={() => navigate('/new')}><Plus size={15} /> New edition</button>
            </div>
          )}
        </>
      )}
      <div className="h-16" />
    </ClothPage>
  );
}

// ---------------------------------------------------------------------------
// The weekly letter: New Acquisitions
// ---------------------------------------------------------------------------

function Inlines({ kids }: { kids: Inline[] }) {
  return (
    <>
      {kids.map((x, i) => {
        if (x.t === 'link') {
          return <a key={i} href={x.href} target="_blank" rel="noreferrer" className="underline underline-offset-2" style={{ color: GOLD }}><Inlines kids={x.kids} /></a>;
        }
        const style: React.CSSProperties = {};
        if (x.b) style.fontWeight = 600;
        if (x.i) style.fontStyle = 'italic';
        return x.b || x.i ? <span key={i} style={style}>{x.s}</span> : <React.Fragment key={i}>{x.s}</React.Fragment>;
      })}
    </>
  );
}

function Letter({ blocks }: { blocks: Block[] }) {
  const body: React.CSSProperties = { fontFamily: SERIF, fontSize: 18, lineHeight: 1.55, color: 'rgba(241,227,184,0.94)' };
  return (
    <div className="space-y-4">
      {blocks.map((blk, i) => {
        if (blk.t === 'hr') return <GiltRule key={i} className="my-8" />;
        if (blk.t === 'h') {
          if (blk.level === 1) return <h1 key={i} style={{ fontFamily: SERIF, fontSize: 36, fontWeight: 600, color: GOLD, lineHeight: 1.1 }}><Inlines kids={blk.kids} /></h1>;
          if (blk.level === 2) return <h2 key={i} className="pt-4" style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 600, color: GOLD, lineHeight: 1.15 }}><Inlines kids={blk.kids} /></h2>;
          return <h3 key={i} className="pt-2" style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 600, color: GOLD }}><Inlines kids={blk.kids} /></h3>;
        }
        if (blk.t === 'ul') {
          return (
            <ul key={i} className="space-y-2.5 pl-5" style={body}>
              {blk.items.map((it, j) => (
                <li key={j} className="relative">
                  <span aria-hidden className="absolute -left-5" style={{ color: GOLD }}>·</span>
                  <Inlines kids={it} />
                </li>
              ))}
            </ul>
          );
        }
        return <p key={i} style={body}><Inlines kids={blk.kids} /></p>;
      })}
    </div>
  );
}

function prettyRange(w: Week): string {
  const f = (d: string, withYear: boolean) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
  return `${f(w.from, false)} – ${f(w.to, true)}`;
}

/** The lead card on the Library page: this week's salutation and the way in. */
function WeeklyCard({ week, navigate }: { week: Week; navigate: (to: string) => void }) {
  const [t, setT] = useState<{ title: string | null; byline: string | null; teaser: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void loadWeekly(week.date).then((md) => { if (live && md) setT(teaserOf(md)); }).catch(() => {});
    return () => { live = false; };
  }, [week.date]);
  return (
    <section className="mt-10">
      <button
        className="block w-full rounded-sm p-6 text-left sm:p-8"
        style={{ background: 'rgba(0,0,0,0.28)', boxShadow: 'inset 0 0 0 1px rgba(217,189,122,0.45), 0 20px 40px rgba(0,0,0,0.35)' }}
        onClick={() => navigate(`/weekly/${week.date}`)}
      >
        <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: 'rgba(217,189,122,0.75)' }}>New Acquisitions · the week of {prettyRange(week)}</div>
        <div className="mt-2" style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 600, color: GOLD, lineHeight: 1.1 }}>This week's letter from the Library</div>
        {t?.teaser && (
          <p className="mt-4 max-w-3xl" style={{ fontFamily: SERIF, fontSize: 18, lineHeight: 1.5, color: 'rgba(241,227,184,0.9)' }}>{t.teaser}</p>
        )}
        <div className="mt-4 inline-flex items-center gap-2 text-[14px] underline underline-offset-4" style={{ color: GOLD }}>
          Read the letter <ChevronRight size={15} />
        </div>
      </button>
    </section>
  );
}

function SpotlightCard({ navigate }: { navigate: (to: string) => void }) {
  const plate = SPOTLIGHT.images.find((im) => im.merch !== false) ?? null;
  return (
    <section className="mt-8">
      <button
        className="block w-full rounded-sm p-6 text-left sm:p-8"
        style={{ background: 'rgba(0,0,0,0.28)', boxShadow: 'inset 0 0 0 1px rgba(217,189,122,0.45)' }}
        onClick={() => navigate('/how')}
      >
        <div className="flex items-center gap-5 sm:gap-8">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: 'rgba(217,189,122,0.75)' }}>How it works</div>
            <div className="mt-2" style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 600, color: GOLD, lineHeight: 1.1 }}>A Spotlight on <em>{SPOTLIGHT.work}</em></div>
            {SPOTLIGHT.author && <div className="mt-1" style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 16, color: 'rgba(233,214,160,0.8)' }}>{SPOTLIGHT.author}</div>}
            <div className="mt-4 inline-flex items-center gap-2 text-[14px] underline underline-offset-4" style={{ color: GOLD }}>
              See it <ChevronRight size={15} />
            </div>
          </div>
          {SPOTLIGHT.slug && plate && (
            <img
              src={spotlightImageUrl(SPOTLIGHT.slug, plate.display ?? plate.file)}
              alt=""
              loading="lazy"
              className="w-24 shrink-0 rounded-sm sm:w-36"
              style={{ boxShadow: '0 0 0 1px rgba(217,189,122,0.35)' }}
            />
          )}
        </div>
      </button>
    </section>
  );
}

/** /weekly and /weekly/<date>: the letter in full, readable without signing in. */
function WeeklyPage({ date, session, navigate }: { date: string | null; session: Session | null; navigate: (to: string) => void }) {
  const [weeks, setWeeks] = useState<Week[] | null>(null);
  const [md, setMd] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadWeeklyIndex().then((ws) => { if (live) setWeeks(ws); }).catch(() => { if (live) setWeeks([]); });
    return () => { live = false; };
  }, []);
  const chosen = date ?? weeks?.[0]?.date ?? null;
  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setMd(undefined);
    void loadWeekly(chosen).then((m) => { if (live) setMd(m); }).catch(() => { if (live) setMd(null); });
    return () => { live = false; };
  }, [chosen]);
  const blocks = useMemo(() => (md ? parseMarkdown(md) : []), [md]);
  const others = (weeks ?? []).filter((w) => w.date !== chosen);
  return (
    <ClothPage session={session} navigate={navigate}>
      <GiltRule className="mt-7" />
      <div className="mx-auto max-w-3xl py-10">
        <button className="mb-6 inline-flex items-center gap-1 text-[13px] underline underline-offset-4" style={{ color: GOLD }} onClick={() => navigate('/')}>
          <ChevronRight size={14} className="rotate-180" /> The Library
        </button>
        {weeks !== null && !chosen && <p style={{ fontFamily: SERIF, fontSize: 18, color: 'rgba(233,214,160,0.7)' }}>No letter has gone out yet.</p>}
        {chosen && md === undefined && <p style={{ fontFamily: SERIF, fontSize: 18, color: 'rgba(233,214,160,0.7)' }}>Opening the letter…</p>}
        {chosen && md === null && <p style={{ fontFamily: SERIF, fontSize: 18, color: 'rgba(233,214,160,0.7)' }}>There is no letter for {chosen}.</p>}
        {md && <Letter blocks={blocks} />}
        {others.length > 0 && (
          <div className="mt-12">
            <GiltRule />
            <div className="mt-4 text-[11px] uppercase tracking-[0.22em]" style={{ color: 'rgba(217,189,122,0.75)' }}>Earlier letters</div>
            <ul className="mt-2 space-y-1">
              {others.map((w) => (
                <li key={w.date}>
                  <button className="underline underline-offset-4" style={{ fontFamily: SERIF, fontSize: 17, color: GOLD }} onClick={() => navigate(`/weekly/${w.date}`)}>
                    {w.title ?? `The week of ${prettyRange(w)}`}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <GiltRule />
    </ClothPage>
  );
}

// ---------------------------------------------------------------------------
// The third page: How it works — a spotlight on one work
// ---------------------------------------------------------------------------

/** Eden picks the work and supplies the pictures and the film; until then the
 *  page stands at /how, unlinked, with the frame in place. The pictures live
 *  in the public bucket under cover-images/spotlight/<slug>/ (set out by the
 *  editors with the service role), so each can go on a tee, a tote or a print
 *  through the same sheet readers use in a book. */
const SPOTLIGHT: {
  work: string | null;
  author: string | null;
  /** The edition the spotlight is about: its rights (public domain) back the merch. */
  editionId: string | null;
  /** The folder under cover-images/spotlight/. */
  slug: string | null;
  /** The pictures: `file` is the full-size original (the copy the print shop gets);
   *  `display`, when given, is the lighter copy the page shows. `merch: false` keeps a
   *  picture off the garments (a screenshot of the Reader, say). */
  images: Array<{ file: string; display?: string; caption?: string; merch?: boolean }>;
  video: string | null;
  intro: string[];
  /** How it works, one step at a time; `image` names a file in `images`. */
  steps: Array<{ title: string; text: string; image?: string }>;
} = {
  work: 'Kunstformen der Natur',
  author: 'Ernst Haeckel, 1899–1904',
  editionId: '550d6557-7df9-4809-87ea-c20d16917ee9',
  slug: 'kunstformen-der-natur',
  images: [
    { file: 'tafel-2-thalamophora.png', display: 'tafel-2-thalamophora.jpg', caption: 'Tafel 2. Thalamophora — Kammerlinge: the foraminifera.' },
    { file: 'orchestrator-answer.png', caption: 'The Orchestrator, asked about Tafel 5.', merch: false },
    { file: 'tafel-5-calcispongiae.png', display: 'tafel-5-calcispongiae.jpg', caption: 'Tafel 5. Calcispongiae — Kalkschwämme: the calcareous sponges.' },
  ],
  video: null,
  intro: [
    'Ernst Haeckel drew these plates between 1899 and 1904: a hundred of them, radiolarians and jellyfish, sponges and orchids, each page arranged like a jeweller’s tray. The book has been in and out of print for a century and in copyright for none of it. It is in the Library, cleaned, in two volumes.',
    'Here is what the Reader does with it.',
  ],
  steps: [
    { title: 'Open the book', image: 'tafel-2-thalamophora.png',
      text: 'The scan is cleaned page by page and shown at the size it was printed. Turn to Tafel 2 and the foraminifera stand out of the black ground as they did in 1899.' },
    { title: 'Ask', image: 'orchestrator-answer.png',
      text: 'The Orchestrator reads the page you are on. Ask what you are looking at and the answer arrives beside the plate, in the length you asked for: here, a hundred and fifty words on the calcareous sponges of Tafel 5.' },
    { title: 'Snip it, bench it, take it further', image: 'tafel-5-calcispongiae.png',
      text: 'Draw a box around a plate, or a detail of one, and it goes to the Workbench. From the bench, one click copies the picture and opens Midjourney, Runway, Flow, Grok or ChatGPT. Paste, and the plate is yours to work on.' },
    { title: 'Wear it',
      text: 'Any picture from a public-domain work can go on a tee, a tote or a print. Choose the garment, see it mocked up with the plate in place, pay, and the print shop makes it and ships it to you.' },
  ],
};

function spotlightImageUrl(slug: string, file: string): string {
  return supabase.storage.from('cover-images').getPublicUrl(`spotlight/${slug}/${file}`).data.publicUrl;
}

function Spotlight({ session, navigate }: { session: Session; navigate: (to: string) => void }) {
  const s = SPOTLIGHT;
  const [sheet, setSheet] = useState<MerchSheetOpen | null>(null);
  const merchReady = !!(s.editionId && s.slug);

  // Back from Stripe: ?merch=paid&order=<id> opens the orders view; ?merch=cancel says so.
  useEffect(() => {
    const back = readMerchReturn(window.location.search);
    if (!back) return;
    window.history.replaceState(null, '', `${window.location.pathname}${stripMerchReturn(window.location.search)}${window.location.hash}`);
    setSheet(back.kind === 'paid'
      ? { kind: 'orders', orderId: back.orderId }
      : { kind: 'orders', orderId: null, notice: 'Checkout was cancelled. Nothing was charged.' });
  }, []);

  const putOnMerch = (file: string) => {
    if (!s.editionId || !s.slug) return;
    const url = spotlightImageUrl(s.slug, file);
    const stem = file.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9._-]/g, '-');
    setSheet({
      kind: 'product',
      itemId: `spotlight-${s.slug}-${stem}`,
      itemUpdatedAt: null,
      source: { kind: 'spotlight', id: s.editionId, slug: s.slug, file },
      preview: url,
      getBlob: async () => { const r = await fetch(url); if (!r.ok) throw new Error('The picture could not be fetched.'); return r.blob(); },
      bookTitle: s.work,
    });
  };

  const picture = (file: string) => s.images.find((im) => im.file === file) ?? null;
  const figure = (im: NonNullable<ReturnType<typeof picture>>) => (
    <figure>
      <img
        src={spotlightImageUrl(s.slug!, im.display ?? im.file)}
        alt={im.caption ?? ''}
        loading="lazy"
        className="w-full rounded-sm"
        style={{ boxShadow: '0 0 0 1px rgba(217,189,122,0.35)' }}
      />
      {im.caption && <figcaption className="mt-2 text-[13px]" style={{ fontFamily: SERIF, fontStyle: 'italic', color: 'rgba(233,214,160,0.75)' }}>{im.caption}</figcaption>}
      {merchReady && im.merch !== false && (
        <button className={`${goldQuiet} mt-2`} style={goldQuietStyle} onClick={() => putOnMerch(im.file)}>
          <Shirt size={14} /> On a tee, a tote or a print
        </button>
      )}
    </figure>
  );
  const shown = new Set(s.steps.map((st) => st.image).filter(Boolean));
  const rest = s.slug ? s.images.filter((im) => !shown.has(im.file)) : [];
  const prose = { fontFamily: SERIF, fontSize: 19, lineHeight: 1.55, color: 'rgba(241,227,184,0.94)' } as const;

  return (
    <ClothPage session={session} navigate={navigate}>
      <GiltRule className="mt-7" />
      <div className="mx-auto max-w-3xl py-10">
        <div className="text-[12px] uppercase tracking-[0.22em]" style={{ color: 'rgba(217,189,122,0.7)' }}>How it works</div>
        <h1 className="mt-2" style={{ fontFamily: SERIF, fontSize: 40, fontWeight: 600, color: GOLD, lineHeight: 1.05 }}>
          A Spotlight on{' '}
          {s.work ? <em style={{ fontStyle: 'italic' }}>{s.work}</em> : <span className="inline-block w-[7ch] border-b" style={{ borderColor: 'rgba(217,189,122,0.6)' }}>&nbsp;</span>}
        </h1>
        {s.author && <div className="mt-2" style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 18, color: 'rgba(233,214,160,0.8)' }}>{s.author}</div>}
        <div className="mt-6 space-y-5" style={prose}>
          {s.intro.length > 0 ? s.intro.map((p, i) => <p key={i}>{p}</p>) : (
            <p style={{ color: 'rgba(233,214,160,0.6)' }}>The work, its pictures and its film are chosen by the editors and will appear here.</p>
          )}
        </div>
        {s.video && (
          <div className="mt-8 overflow-hidden rounded-sm" style={{ boxShadow: '0 0 0 1px rgba(217,189,122,0.35)' }}>
            <video src={s.video} controls playsInline className="block w-full" />
          </div>
        )}
        {s.steps.length > 0 && (
          <ol className="mt-10 space-y-12">
            {s.steps.map((st, i) => {
              const im = st.image && s.slug ? picture(st.image) : null;
              return (
                <li key={i} className={`grid grid-cols-1 gap-6 sm:items-start ${im ? 'sm:grid-cols-2' : ''}`}>
                  <div className={im && i % 2 === 1 ? 'sm:order-2' : ''}>
                    <div className="flex items-baseline gap-3">
                      <span style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 600, color: GOLD, lineHeight: 1 }}>{i + 1}</span>
                      <h2 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 600, color: GOLD, lineHeight: 1.15 }}>{st.title}</h2>
                    </div>
                    <p className="mt-3" style={prose}>{st.text}</p>
                  </div>
                  {im && <div className={i % 2 === 1 ? 'sm:order-1' : ''}>{figure(im)}</div>}
                </li>
              );
            })}
          </ol>
        )}
        {rest.length > 0 && (
          <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2">
            {rest.map((im) => <div key={im.file}>{figure(im)}</div>)}
          </div>
        )}
        <div className="mt-10 flex flex-wrap gap-3">
          {s.editionId && (
            <button className={goldPrimary} style={{ background: GOLD, color: CLOTH }} onClick={() => navigate(`/read/${s.editionId}`)}><BookOpen size={16} /> Open the edition</button>
          )}
          {merchReady && (
            <button className={goldQuiet} style={goldQuietStyle} onClick={() => setSheet({ kind: 'orders', orderId: null })}>My orders</button>
          )}
        </div>
      </div>
      <GiltRule />
      {sheet && (
        <MerchSheet
          key={sheet.kind === 'product' ? sheet.itemId : 'orders'}
          open={sheet}
          userId={session.user.id}
          returnPath={`${BASE}/how`}
          onClose={() => setSheet(null)}
        />
      )}
    </ClothPage>
  );
}

// ---------------------------------------------------------------------------
// New edition: a PDF, a title, an author
// ---------------------------------------------------------------------------

/** The books already in Contextspaces, to pick one as the edition's book. */
function LibraryPicker({ chosen, onChoose }: { chosen: LibraryBook | null; onChoose: (b: LibraryBook) => void }) {
  const [q, setQ] = useState('');
  // null = a search is running: the list is EMPTY meanwhile, so a tap cannot
  // land on a row from the previous search (the first phone test chose the
  // newest book on the shelf that way, while "Innocents" was still loading).
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      listLibraryPdfs(q)
        .then((b) => { if (live) { setBooks(b); setTrouble(null); } })
        .catch((e: unknown) => { if (live) { setBooks([]); setTrouble(e instanceof Error ? e.message : 'The library could not be read.'); } });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  // Typing starts a new search: clear the rows at once, not after the debounce.
  const onType = (value: string) => { setQ(value); setBooks(null); };

  return (
    <div className="rounded-lg border border-[#c9b98f] bg-[#fbf6ea]">
      <div className="flex items-center gap-2 border-b border-[#e3d4ad] px-3 py-2">
        <Search size={14} className="opacity-50" />
        <input
          className="w-full bg-transparent text-[14px] outline-none placeholder:text-[#a08f6a]"
          placeholder="Find a book by its title"
          value={q}
          onChange={(e) => onType(e.target.value)}
        />
      </div>
      {chosen && (
        <div className="border-b border-[#e3d4ad] bg-[#f1e6c9] px-3 py-2 text-[13px]">
          <span className="opacity-60">Chosen: </span>
          <span style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 600 }}>{chosen.title}</span>
          {chosen.matter && <span className="opacity-60"> · {chosen.matter}</span>}
        </div>
      )}
      <Trouble text={trouble} />
      <div className="max-h-64 overflow-y-auto">
        {books === null ? (
          <p className="px-3 py-3 text-[13px] opacity-60">{q ? `Looking for "${q}"…` : 'Looking on the shelves…'}</p>
        ) : books.length === 0 ? (
          <p className="px-3 py-3 text-[13px] opacity-60">{q ? 'No PDF by that title.' : 'No PDFs in Equazia yet.'}</p>
        ) : books.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onChoose(b)}
            className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-[#f1e6c9] ${chosen?.id === b.id ? 'bg-[#f1e6c9]' : ''}`}
          >
            <span className="min-w-0">
              <span className="block truncate text-[14px]" style={{ fontFamily: SERIF, fontSize: 16 }}>{b.title}</span>
              {b.matter && <span className="block truncate text-[11px] opacity-60">{b.matter}</span>}
            </span>
            {b.bytes != null && <span className="shrink-0 text-[11px] opacity-50">{(b.bytes / 1048576).toFixed(1)} MB</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function NewEdition({ navigate }: { navigate: (to: string) => void }) {
  const [door, setDoor] = useState<'library' | 'upload'>('library');
  const [book, setBook] = useState<LibraryBook | null>(null);
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
  // A title the picker set is replaced by the next pick; one typed by hand is kept.
  const pickedTitles = useRef(new Set<string>());
  const choose = (b: LibraryBook) => {
    setBook(b);
    if (!title.trim() || pickedTitles.current.has(title)) setTitle(b.title);
    pickedTitles.current.add(b.title);
  };

  const ready = door === 'library' ? !!book : !!file;

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setTrouble(null);
    let edition: Edition | null = null;
    try {
      setBusy('Making the edition…');
      edition = await createEdition({ title, author: author || null });
      if (door === 'library' && book) {
        setBusy('Copying the book from Equazia…');
        await copyBookFromDocument(edition, book.id);
      } else if (file) {
        setBusy('Uploading the book…');
        setProgress(0);
        await uploadAsset(edition, 'book', file, {
          onProgress: ({ loaded, total }) => setProgress(total ? loaded / total : null),
        });
      }
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
      <p className="mt-4 text-[14px] opacity-70">
        A PDF — a facsimile of a public-domain book, or a book of your own. The Workshop opens beside it.
      </p>

      <form onSubmit={make} className="mt-6 space-y-4">
        <div className="flex gap-2">
          <button type="button" onClick={() => setDoor('library')} className={`${quiet} flex-1 justify-center ${door === 'library' ? 'bg-[#f1e6c9] border-[#8a6d2f]' : ''}`}>
            <LibraryIcon size={14} /> From Equazia
          </button>
          <button type="button" onClick={() => setDoor('upload')} className={`${quiet} flex-1 justify-center ${door === 'upload' ? 'bg-[#f1e6c9] border-[#8a6d2f]' : ''}`}>
            <Upload size={14} /> Upload a PDF
          </button>
        </div>

        {door === 'library' ? (
          <LibraryPicker chosen={book} onChoose={choose} />
        ) : (
          <>
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
          </>
        )}
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
        <button className={primary} type="submit" disabled={!ready || !title.trim() || !!busy}>
          <ChevronRight size={15} /> Open in the Reader
        </button>
        {!busy && (door === 'upload' || ready) && (!ready || !title.trim()) && (
          <p className="text-[12px] opacity-60">
            {!ready ? 'Choose the PDF first: tap the box above and pick it from your files.' : 'Give it a title.'}
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
    <div className="fixed inset-0 overflow-hidden">
      <PdfBook
        source={source}
        marks={marks}
        bench={bench}
        merch={mine}
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
    document.title = route.name === 'how' ? 'How it works — Grapheon Reader' : route.name === 'weekly' ? 'New Acquisitions — Grapheon Reader' : 'Grapheon Reader';
  }, [route, session]);

  if (!ready) return <Shell><p className="pt-10 text-[14px] opacity-60">…</p></Shell>;
  if (route.name === 'weekly') return <WeeklyPage date={route.date} session={session} navigate={navigate} />;
  if (!session) return <SignIn />;
  if (route.name === 'new') return <NewEdition navigate={navigate} />;
  if (route.name === 'how') return <Spotlight session={session} navigate={navigate} />;
  if (route.name === 'read') return <Read key={route.id} id={route.id} session={session} navigate={navigate} />;
  return <Library session={session} navigate={navigate} />;
}
