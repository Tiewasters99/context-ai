// The matter's Record — one chronological docket of what was done to this
// matter and every sub-matter, and the button that exports it.
//
// Deliberately plain: a status line, two filters, and a list of lines. No
// charts, no tiles. It is a docket, and a docket is read top to bottom.
//
// The ledger holds metadata only, and this surface fetches nothing else: no
// document text is read here, by design.

import { useMemo, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { useMatterRecord } from '@/hooks/useMatterRecord';
import { chainSummary, describeEvent, isoMinute, kindLabel } from '@/lib/matter-record/describe';
import type { LedgerEvent, MatterRef } from '@/lib/matter-record/types';
import MatterRecordExport from './MatterRecordExport';

interface Props {
  matter: MatterRef;
}

const SELECT_CLASS =
  'bg-[#12121a] border border-[rgba(255,255,255,0.14)] rounded-md px-2.5 py-1.5 ' +
  'text-[13px] text-[#f5f1e8] focus:outline-none focus:border-[#e8b84a]/60';

export default function RecordTab({ matter }: Props) {
  const { data, isLoading, error } = useMatterRecord(matter);
  const [kind, setKind] = useState<string>('all');
  const [subMatter, setSubMatter] = useState<string>('all');

  const events = useMemo<LedgerEvent[]>(() => {
    if (!data) return [];
    // fetch returns oldest first; a docket is read newest first.
    return [...data.events].reverse();
  }, [data]);

  const kinds = useMemo(() => {
    const set = new Set(events.map((e) => e.kind));
    return [...set].sort();
  }, [events]);

  const shown = useMemo(
    () =>
      events.filter(
        (e) =>
          (kind === 'all' || e.kind === kind) &&
          (subMatter === 'all' || e.matterspace_id === subMatter),
      ),
    [events, kind, subMatter],
  );

  const status = useMemo(() => chainSummary(data?.chains ?? []), [data?.chains]);

  if (isLoading) {
    return <p className="text-[13px] text-white/40 py-8 text-center">Reading the record…</p>;
  }

  if (error) {
    return (
      <p className="text-[13px] text-red-300 py-8 text-center">
        {error instanceof Error ? error.message : 'Failed to read the record'}
      </p>
    );
  }

  if (data?.notDeployed) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <ScrollText size={26} className="text-white/20 mb-3" strokeWidth={1.5} />
        <p className="text-[13px] text-white/50">The record is not enabled yet.</p>
      </div>
    );
  }

  if (data?.error) {
    return <p className="text-[13px] text-red-300 py-8 text-center">{data.error}</p>;
  }

  const people = data?.people ?? {};

  return (
    <div className="flex flex-col gap-4">
      {/* Chain status — plain words, and what they mean. */}
      <div className="rounded-lg border border-[rgba(255,255,255,0.14)] px-4 py-3">
        <p
          className={`text-[14px] ${status.ok ? 'text-[#f5f1e8]' : 'text-[#e8b84a]'}`}
        >
          {status.line}
        </p>
        <p className="text-[12px] text-white/45 mt-1 leading-snug">{status.meaning}</p>
        {data?.truncated && (
          <p className="text-[12px] text-white/45 mt-1">
            Showing {data.events.length} of {data.totalEvents ?? 'many'} entries — the export
            covers the same range.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          className={SELECT_CLASS}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Filter by what happened"
        >
          <option value="all">Everything</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>

        {(data?.matters.length ?? 0) > 1 && (
          <select
            className={SELECT_CLASS}
            value={subMatter}
            onChange={(e) => setSubMatter(e.target.value)}
            aria-label="Filter by matter"
          >
            <option value="all">This matter and its sub-matters</option>
            {(data?.matters ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}

        <span className="text-[12px] text-white/35">
          {shown.length} {shown.length === 1 ? 'entry' : 'entries'}
        </span>

        <div className="ml-auto">
          {data && <MatterRecordExport matter={matter} data={data} />}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <ScrollText size={26} className="text-white/20 mb-3" strokeWidth={1.5} />
          <p className="text-[13px] text-white/50">
            {events.length === 0
              ? 'Nothing has been recorded on this matter yet. AI answers, tool calls, membership and seal changes appear here.'
              : 'No entries of that kind.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.06)]">
          {shown.map((event) => (
            <div key={event.id} className="flex items-start gap-3 px-4 py-2.5">
              <span className="text-[11px] text-white/35 shrink-0 w-[132px] pt-0.5 tabular-nums">
                {isoMinute(event.ts)}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] text-[#f5f1e8] leading-snug">
                  {describeEvent(event, people)}
                </span>
                <span className="text-[11px] text-white/35">
                  {kindLabel(event.kind)}
                  {event.matter_name && event.matterspace_id !== matter.id && (
                    <> · {event.matter_name}</>
                  )}
                  {event.seq ? <> · entry {event.seq}</> : null}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
