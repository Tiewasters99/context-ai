import { useEffect, useState } from 'react';
import { Scale, Loader2, Check, AlertCircle, Lock } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import { useAuth } from '@/contexts/AuthContext';
import { guessInitials } from '@/lib/brief/confirmations-core';
import { rememberedInitials, rememberInitials } from '@/lib/brief/confirmations';
import { getGrade, saveGrade, type CandidateContext, type Grade } from '@/lib/comparator/data';

// The grade card (Model Comparator, spec §2): one per candidate, on the
// candidate document in the reader. A 1–10 score for every rubric dimension,
// overall, a comment, the grader's initials and the time — the Brief Desk's
// initials discipline (migration 103; the initials memory is the same one,
// src/lib/brief/confirmations.ts). The database checks every dimension is
// scored and stamps the time; after the reveal the card is frozen.

const SCORES = Array.from({ length: 10 }, (_, i) => i + 1);
const SELECT = 'px-2 py-1.5 rounded-md border border-[rgba(255,255,255,0.1)] bg-[#181820] text-[12px] text-white focus:outline-none focus:ring-1 focus:ring-[#e8b84a]';

export function CandidateChip({ ctx, onOpen }: { ctx: CandidateContext; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="fixed bottom-5 right-5 z-[45] inline-flex items-center gap-2 px-3.5 py-2 rounded-full border border-[rgba(232,184,74,0.35)] bg-[rgba(12,12,18,0.92)] text-[12px] text-[#f0c850] shadow-xl backdrop-blur hover:bg-[rgba(232,184,74,0.12)]"
      title="This document is a candidate in a model comparison — open its grade card"
    >
      <Scale size={13} /> Candidate {ctx.candidate.label} · grade card
    </button>
  );
}

export default function CandidateGradeCard({ ctx, onClose }: { ctx: CandidateContext; onClose: () => void }) {
  const { user } = useAuth();
  const rubric = ctx.comparison.rubric;
  const frozen = !!ctx.comparison.revealed_at;
  const [grade, setGrade] = useState<Grade | null>(null);
  const [loading, setLoading] = useState(true);
  const [scores, setScores] = useState<Record<string, number | null>>(() => Object.fromEntries(rubric.map((d) => [d.key, null])));
  const [overall, setOverall] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [initials, setInitials] = useState(() => {
    const meta = user?.user_metadata as { full_name?: string; name?: string } | undefined;
    return rememberedInitials() ?? guessInitials(meta?.full_name ?? meta?.name ?? null, user?.email ?? null);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    getGrade(ctx.candidate.id)
      .then((g) => {
        if (!live) return;
        setGrade(g);
        if (g) {
          setScores(Object.fromEntries(rubric.map((d) => [d.key, Number.isFinite(g.scores?.[d.key]) ? g.scores[d.key] : null])));
          setOverall(g.overall);
          setComment(g.comment ?? '');
        }
        setLoading(false);
      })
      .catch((e: unknown) => { if (live) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { live = false; };
  }, [ctx.candidate.id, rubric]);

  const complete = rubric.every((d) => scores[d.key] != null) && overall != null && initials.trim().length > 0;

  const save = async () => {
    if (!complete || frozen) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const g = await saveGrade(ctx, {
        scores: Object.fromEntries(rubric.map((d) => [d.key, scores[d.key] as number])),
        overall: overall as number,
        comment: comment.trim(),
        initials,
      });
      rememberInitials(initials);
      setGrade(g);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  return (
    <CardDialog
      storageKey="cs.dialog.candidateGradeCard"
      z={70}
      maxWidth={440}
      onClose={onClose}
      busy={saving}
      icon={<Scale size={15} className="text-[#e8b84a]" />}
      title={`Grade card — Candidate ${ctx.candidate.label}`}
      subtitle={ctx.comparison.title}
      bodyClassName="px-5 py-4 flex flex-col gap-3"
      footer={frozen ? (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/50"><Lock size={11} /> Revealed — this grade card is frozen.</span>
      ) : (
        <>
          {saved && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400/90 mr-auto"><Check size={12} /> Signed</span>}
          <button onClick={onClose} className="text-[12px] text-white/50 hover:text-white px-2 py-1">Close</button>
          <button
            onClick={() => void save()}
            disabled={!complete || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[12px] font-bold disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {grade ? 'Re-sign' : 'Sign grade card'}
          </button>
        </>
      )}
    >
      {loading ? (
        <p className="flex items-center gap-2 text-[12px] text-white/50"><Loader2 size={13} className="animate-spin" /> Loading…</p>
      ) : (
        <>
          <p className="text-[11px] text-white/50 leading-snug">
            Score each dimension 1–10. Margin notes you tag with a dimension land under it in the Comparison notes.
            {ctx.candidate.word_count != null && <> Word count: {ctx.candidate.word_count.toLocaleString('en-US')}.</>}
          </p>
          <div className="flex flex-col gap-1.5">
            {rubric.map((d) => (
              <label key={d.key} className="flex items-center gap-3">
                <span className="flex-1 text-[12px] text-white/85">{d.label}</span>
                <select
                  value={scores[d.key] ?? ''}
                  disabled={frozen}
                  onChange={(e) => setScores((prev) => ({ ...prev, [d.key]: e.target.value ? Number(e.target.value) : null }))}
                  className={SELECT}
                >
                  <option value="">—</option>
                  {SCORES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ))}
            <label className="flex items-center gap-3 pt-1.5 mt-1 border-t border-white/[0.08]">
              <span className="flex-1 text-[12px] font-semibold text-white">Overall</span>
              <select value={overall ?? ''} disabled={frozen} onChange={(e) => setOverall(e.target.value ? Number(e.target.value) : null)} className={SELECT}>
                <option value="">—</option>
                {SCORES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.08em] text-white/45">Comment</span>
            <textarea
              value={comment}
              disabled={frozen}
              onChange={(e) => setComment(e.target.value)}
              rows={5}
              maxLength={8000}
              className="w-full resize-y rounded-md bg-white/5 border border-white/10 px-2.5 py-2 text-[13px] text-white/90 outline-none focus:border-[rgba(212,160,84,0.5)] disabled:opacity-60"
            />
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.08em] text-white/45">Initials</span>
            <input
              value={initials}
              disabled={frozen}
              onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 6))}
              className="w-20 px-2 py-1 rounded-md border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] text-[12px] text-white uppercase focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
            />
            {grade && (
              <span className="text-[11px] text-white/40 ml-auto">
                Signed {grade.initials} · {new Date(grade.graded_at).toISOString().slice(0, 16).replace('T', ' ')} UTC
              </span>
            )}
          </div>
          {error && <p className="flex items-start gap-2 text-[12px] text-red-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}</p>}
        </>
      )}
    </CardDialog>
  );
}
