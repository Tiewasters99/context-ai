import { useCallback, useEffect, useMemo, useState } from 'react';
import { Layers, Plus, Trash2, X, Send } from 'lucide-react';
import {
  listSets, createSet, deleteSet, isSetsMissing, matchesRule, isFilterEmpty, isRuleEmpty, describeRule, splitForProduction,
  produceFromSet,
  type DiscoverySet, type DocumentTagDef, type FilterRule, type ReviewDocument, type SetRule,
} from '@/lib/discovery';

// Discovery R2 (spec DISCOVERY-REVIEW-SETS-2026-10-12, 3.3): sets on the
// Review tab. A set is a saved filter (it stays current as review goes on)
// or a hand-picked list; "Produce this set" freezes its documents into a new
// outgoing production. Privileged documents go in and are withheld at
// stamping (and listed on the privilege log); Non-Responsive and Irrelevant
// never go in.

const inputCls = '[color-scheme:dark] bg-white/[0.04] border border-white/10 rounded-md px-2 py-1 text-[12px] text-white/85 outline-none focus:border-[#e8b84a]/50';

export default function SetsBar({
  matterId, defs, docs, tagsByDoc, currentFilter, selectedIds, activeSetId, onActivate, onProduced, tagsReady,
}: {
  matterId: string;
  defs: DocumentTagDef[];
  docs: ReviewDocument[];
  tagsByDoc: Map<string, Set<string>>;
  currentFilter: FilterRule;
  selectedIds: string[];
  activeSetId: string | null;
  onActivate: (set: DiscoverySet | null) => void;
  onProduced: () => void;
  /** False until 113 is pasted: a production built without tags would
   *  produce what should be withheld. */
  tagsReady: boolean;
}) {
  const [sets, setSets] = useState<DiscoverySet[]>([]);
  const [needsSql, setNeedsSql] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The rule being saved, copied at the moment "Save these filters" or "Save
  // the N ticked" is clicked. Saving reads this copy, never the live filters:
  // clicking a set or "Stop using it" while the name box is open clears the
  // filters below, and saving the live filter then saved an empty rule (the
  // whole matter, 2026-10-13). The copy stays put and the row says so.
  const [pending, setPending] = useState<SetRule | null>(null);
  const [saveName, setSaveName] = useState('');
  const [producing, setProducing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listSets(matterId).then((rows) => {
      if (cancelled) return;
      setSets(rows);
      setNeedsSql(false);
    }).catch((e) => {
      if (cancelled) return;
      const msg = e instanceof Error ? e.message : '';
      if (isSetsMissing(msg)) setNeedsSql(true); else setError(msg);
    });
    return () => { cancelled = true; };
  }, [matterId]);

  const docsOf = useCallback(
    (rule: SetRule) => docs.filter((d) => matchesRule(d, tagsByDoc.get(d.id), rule)),
    [docs, tagsByDoc],
  );
  const active = sets.find((s) => s.id === activeSetId) ?? null;

  const startSaving = (rule: SetRule) => {
    setError(null);
    setPending(rule.kind === 'list'
      ? { kind: 'list', document_ids: [...rule.document_ids] }
      : { ...rule, tags_has: [...rule.tags_has], tags_not: [...rule.tags_not] });
  };

  const save = async () => {
    if (!pending || !saveName.trim()) return;
    if (isRuleEmpty(pending)) { setError('Nothing to save: set a filter or tick documents first.'); return; }
    setError(null);
    try {
      const created = await createSet(matterId, saveName, pending);
      setSets((prev) => [...prev, created]);
      setPending(null);
      setSaveName('');
      onActivate(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the set');
    }
  };

  const remove = async (set: DiscoverySet) => {
    setError(null);
    try {
      await deleteSet(set.id);
      setSets((prev) => prev.filter((s) => s.id !== set.id));
      if (activeSetId === set.id) onActivate(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the set');
    }
  };

  if (needsSql) {
    return (
      <div className="mb-3 rounded-md border border-[#e8b84a]/30 bg-[#e8b84a]/10 px-3 py-2 text-[12px] text-[#e8b84a]">
        Sets need one database update (migration 114) that has not been run yet.
      </div>
    );
  }

  const filterEmpty = isFilterEmpty(currentFilter);

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-white/55 inline-flex items-center gap-1 mr-1">
          <Layers size={12} /> Sets:
        </span>
        {sets.length === 0 && !pending && (
          <span className="text-[11px] text-white/40">none yet. Filter or tick documents, then save them as a set.</span>
        )}
        {sets.map((s) => {
          const on = s.id === activeSetId;
          return (
            <button
              key={s.id}
              onClick={() => onActivate(on ? null : s)}
              title={on ? 'Stop using this set' : s.rule.kind === 'list' ? 'A hand-picked list of documents' : 'A saved filter: it picks up documents tagged later'}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px] transition-colors ${
                on ? 'border-[#e8b84a] bg-[#e8b84a]/15 text-[#e8b84a]' : 'border-white/15 text-white/75 hover:border-white/30'
              }`}
            >
              {s.name}
              <span className="tabular-nums text-white/45">{docsOf(s.rule).length}</span>
            </button>
          );
        })}
        {!pending && (
          <>
            <button
              onClick={() => startSaving(currentFilter)}
              disabled={filterEmpty}
              title={filterEmpty ? 'Set a filter first (a tag, a folder, a name...)' : 'Save the current filters as a set'}
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-white/20 px-2 py-0.5 text-[12px] text-white/60 hover:text-white hover:border-white/40 disabled:opacity-35"
            >
              <Plus size={11} /> Save these filters
            </button>
            {selectedIds.length > 0 && (
              <button
                onClick={() => startSaving({ kind: 'list', document_ids: selectedIds })}
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-white/20 px-2 py-0.5 text-[12px] text-white/60 hover:text-white hover:border-white/40"
              >
                <Plus size={11} /> Save the {selectedIds.length} ticked
              </button>
            )}
          </>
        )}
        {pending && (
          <span className="inline-flex items-center gap-1.5">
            <input
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setPending(null); }}
              placeholder={pending.kind === 'list' ? `Name for the ${pending.document_ids.length} ticked documents` : 'Name for this set, e.g. RFP 1-12 responsive'}
              className={`${inputCls} w-[260px]`}
            />
            <button
              onClick={() => void save()}
              disabled={!saveName.trim()}
              className="px-2 py-0.5 rounded-md border border-[#e8b84a]/40 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/10 disabled:opacity-35"
            >
              Save
            </button>
            <button onClick={() => setPending(null)} className="text-[12px] text-white/45 hover:text-white">Cancel</button>
          </span>
        )}
      </div>
      {pending && (
        <p className="mt-1.5 text-[12px] text-white/60">
          Saving: <span className="text-[#e8b84a]">{describeRule(pending, defs)}</span>
          {' · '}<span className="tabular-nums">{docsOf(pending).length}</span> {docsOf(pending).length === 1 ? 'document' : 'documents'} now
          <span className="text-white/40">
            {' '}(taken when you clicked Save; changing the filters below does not change it{pending.kind === 'filter' ? ', but documents tagged later will join it' : ''})
          </span>
        </p>
      )}

      {active && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
          <span className="text-white/60">
            Showing the set <span className="text-[#e8b84a]">{active.name}</span>
            {active.rule.kind === 'filter' && <span className="text-white/40"> (its filters are filled in below)</span>}
          </span>
          <button
            onClick={() => setProducing(true)}
            disabled={!tagsReady}
            title={tagsReady ? 'Start an outgoing production with these documents' : 'Tags need migration 113 first'}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#e8b84a]/15 border border-[#e8b84a]/40 text-[#e8b84a] hover:bg-[#e8b84a]/25 disabled:opacity-35"
          >
            <Send size={12} /> Produce this set…
          </button>
          <button onClick={() => void remove(active)} className="inline-flex items-center gap-1 text-white/45 hover:text-[#e07a6a]">
            <Trash2 size={12} /> Delete set
          </button>
          <button onClick={() => onActivate(null)} className="inline-flex items-center gap-1 text-white/45 hover:text-white">
            <X size={12} /> Stop using it
          </button>
        </div>
      )}
      {error && <p className="mt-1.5 text-[12px] text-red-300">{error}</p>}

      {producing && active && (
        <ProducePanel
          matterId={matterId}
          set={active}
          docs={docsOf(active.rule)}
          matterTotal={docs.length}
          tagsByDoc={tagsByDoc}
          defs={defs}
          onClose={() => setProducing(false)}
          onDone={() => { setProducing(false); onProduced(); }}
        />
      )}
    </div>
  );
}

// Above this many documents the Produce box asks for one more click.
const LARGE_SET = 1000;

function ProducePanel({
  matterId, set, docs, matterTotal, tagsByDoc, defs, onClose, onDone,
}: {
  matterId: string;
  set: DiscoverySet;
  docs: ReviewDocument[];
  /** Every document on the Review tab, to tell a whole-matter set apart. */
  matterTotal: number;
  tagsByDoc: Map<string, Set<string>>;
  defs: DocumentTagDef[];
  onClose: () => void;
  onDone: () => void;
}) {
  const split = useMemo(() => splitForProduction(docs, tagsByDoc, defs), [docs, tagsByDoc, defs]);
  const [name, setName] = useState(set.name);
  const [party, setParty] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [refs, setRefs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = [...split.produce, ...split.privileged];
  // A set that is the whole matter, or a very large one, takes one more
  // deliberate click: on 2026-10-13 a set that had lost its filter took in the
  // whole matter (2,660 documents) behind an ordinary-looking button.
  const wholeMatter = docs.length > 0 && docs.length === matterTotal;
  const needsConfirm = wholeMatter || sending.length > LARGE_SET;
  const [confirmed, setConfirmed] = useState(false);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await produceFromSet({
        matterspaceId: matterId,
        set,
        rule: set.rule,
        documentIds: sending.map((d) => d.id),
        name,
        receivingParty: party.trim() || null,
        productionDate: date || null,
        requestRefs: refs.trim() || null,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the production');
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-[#e8b84a]/30 bg-[rgba(18,18,28,0.85)] p-4 text-[12.5px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[#f5f1e8] font-medium">Produce the set &ldquo;{set.name}&rdquo;</span>
        <button onClick={onClose} className="text-white/45 hover:text-white"><X size={14} /></button>
      </div>
      {needsConfirm && (
        <div className="mb-3 rounded-md border border-[#e8b84a]/60 bg-[#e8b84a]/12 px-3 py-2 text-[#e8b84a]">
          <p className="text-[13px] font-medium">
            {wholeMatter
              ? <>This set is the whole matter: <span className="tabular-nums">{docs.length}</span> documents.</>
              : <>This is a large production: <span className="tabular-nums">{sending.length}</span> documents.</>}
          </p>
          <p className="text-[11.5px] text-[#e8b84a]/80 mt-0.5">
            {set.rule.kind === 'filter' ? <>The set's filter: {describeRule(set.rule, defs)}. </> : null}
            Taking this many documents in can take a long time. Check this is what you meant.
          </p>
          <label className="mt-1.5 flex items-center gap-2 text-[12px] cursor-pointer">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Yes, produce all <span className="tabular-nums">{sending.length}</span> documents
          </label>
        </div>
      )}
      <ul className="space-y-1 mb-3 text-white/75">
        <li><span className="tabular-nums text-[#e8b84a]">{split.produce.length}</span> {split.produce.length === 1 ? 'document' : 'documents'} will be produced (Bates-stamped).</li>
        {split.privileged.length > 0 && (
          <li>
            <span className="tabular-nums text-[#f87171]">{split.privileged.length}</span> tagged Privileged go in and are <b>withheld</b> when you stamp, and listed on the privilege log.
            <Names list={split.privileged} />
          </li>
        )}
        {split.heldBack.length > 0 && (
          <li>
            <span className="tabular-nums">{split.heldBack.length}</span> tagged Non-Responsive or Irrelevant are left out.
            <Names list={split.heldBack} />
          </li>
        )}
        {split.blocked.length > 0 && (
          <li className="text-[#e8b84a]/90">
            <span className="tabular-nums">{split.blocked.length}</span> cannot be produced from the matter (no stored file, or too large) and are left out.
            <Names list={split.blocked} />
          </li>
        )}
      </ul>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
        <label className="flex flex-col gap-1 text-[11px] text-white/50">Production name
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-white/50">Produced to
          <input value={party} onChange={(e) => setParty(e.target.value)} placeholder="e.g. Counsel for Defendants" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-white/50">Production date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-white/50">Requests (optional)
          <input value={refs} onChange={(e) => setRefs(e.target.value)} placeholder="e.g. RFP 1-12" className={inputCls} />
        </label>
      </div>
      <p className="text-[11px] text-white/45 mb-3">
        The documents are frozen into the production now. Later tags on the documents do not change it;
        their tags come with them, and you stamp it from the Review Room as usual.
      </p>
      {error && <p className="text-[12px] text-red-300 mb-2">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void go()}
          disabled={busy || sending.length === 0 || !name.trim() || (needsConfirm && !confirmed)}
          className="px-3 py-1.5 rounded-md bg-[#e8b84a]/15 border border-[#e8b84a]/40 text-[#e8b84a] hover:bg-[#e8b84a]/25 disabled:opacity-35"
        >
          {busy ? 'Starting…' : `Create the production with ${sending.length} ${sending.length === 1 ? 'document' : 'documents'}`}
        </button>
        <button onClick={onClose} className="text-white/50 hover:text-white">Cancel</button>
      </div>
    </div>
  );
}

function Names({ list }: { list: ReviewDocument[] }) {
  return (
    <span className="text-white/40"> ({list.slice(0, 5).map((d) => d.title).join('; ')}{list.length > 5 ? `; and ${list.length - 5} more` : ''})</span>
  );
}
