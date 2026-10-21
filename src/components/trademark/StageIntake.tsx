// Stage 1 — Intake. The mark exactly as it will be used, its format, the
// goods and services in plain language (including planned ones), the users,
// the applicant block and the known marks.

import { useState } from 'react';
import { saveIntake, type Applicant, type ClearanceBundle } from '@/lib/trademark/data';
import type { KnownMark } from '../../../lib/trademark/queries.mjs';
import { btn, btnPrimary, field, label } from './styles';
import { ErrorLine, Note, Panel } from './ui';
import SignOff from './SignOff';

export default function StageIntake({ b, initials, setInitials, onChanged }: {
  b: ClearanceBundle; initials: string; setInitials: (v: string) => void; onChanged: () => Promise<void>;
}) {
  const c = b.clearance;
  const [mark, setMark] = useState(c.mark);
  const [format, setFormat] = useState(c.mark_format);
  const [goods, setGoods] = useState(c.goods_services);
  const [users, setUsers] = useState(c.users);
  const [a, setA] = useState<Applicant>(c.applicant ?? {});
  const [known, setKnown] = useState<KnownMark[]>(c.known_marks?.length ? c.known_marks : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const setApp = (k: keyof Applicant, v: string) => setA((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      await saveIntake(c, {
        mark: mark.trim(), mark_format: format, goods_services: goods, users, applicant: a,
        known_marks: known.filter((k) => k.name.trim()).map((k) => ({ name: k.name.trim(), owner: (k.owner ?? '').trim(), note: (k.note ?? '').trim() })),
      });
      setSaved(true);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel id="tm-stage-1" title="1. Intake">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={label}>Mark (exactly as used)</span>
          <input className={field} value={mark} onChange={(e) => setMark(e.target.value)} maxLength={200} />
        </div>
        <div>
          <span className={label}>Format</span>
          <select className={field} value={format} onChange={(e) => setFormat(e.target.value as 'standard' | 'stylized')}>
            <option value="standard">Standard characters</option>
            <option value="stylized">Stylized</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <span className={label}>Goods and services, in plain language (include planned ones)</span>
          <textarea className={`${field} min-h-[72px]`} value={goods} onChange={(e) => setGoods(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <span className={label}>Intended users</span>
          <input className={field} value={users} onChange={(e) => setUsers(e.target.value)} />
        </div>
      </div>

      <h4 className="mt-4 mb-2 text-[12px] font-semibold text-white/80">Applicant</h4>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2"><span className={label}>Legal name</span><input className={field} value={a.legal_name ?? ''} onChange={(e) => setApp('legal_name', e.target.value)} /></div>
        <div><span className={label}>Entity type</span><input className={field} value={a.entity_type ?? ''} onChange={(e) => setApp('entity_type', e.target.value)} placeholder="LLC, corporation…" /></div>
        <div><span className={label}>State</span><input className={field} value={a.state ?? ''} onChange={(e) => setApp('state', e.target.value)} /></div>
        <div>
          <span className={label}>Formation status</span>
          <select className={field} value={a.formation_status ?? ''} onChange={(e) => setApp('formation_status', e.target.value)}>
            <option value="">Not stated</option>
            <option value="formed">Formed</option>
            <option value="pending">Pending</option>
            <option value="individual">Individual</option>
          </select>
        </div>
        <div><span className={label}>Formation / effective date</span><input type="date" className={field} value={a.formation_date ?? ''} onChange={(e) => setApp('formation_date', e.target.value)} /></div>
        <div className="sm:col-span-3"><span className={label}>Domicile address</span><input className={field} value={a.domicile_address ?? ''} onChange={(e) => setApp('domicile_address', e.target.value)} /></div>
        <div className="sm:col-span-2"><span className={label}>Mailing address</span><input className={field} value={a.mailing_address ?? ''} onChange={(e) => setApp('mailing_address', e.target.value)} /></div>
        <div>
          <span className={label}>Address is a PMB, mail drop or P.O. box?</span>
          <select className={field} value={a.address_is_mail_drop ?? ''} onChange={(e) => setApp('address_is_mail_drop', e.target.value)}>
            <option value="">Not stated</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
      </div>

      <h4 className="mt-4 mb-2 text-[12px] font-semibold text-white/80">Known marks</h4>
      <Note>Marks you already know of. Each gets its own name and owner query, with no class or live filter, so abandoned filings by the same owner appear.</Note>
      <div className="mt-2 space-y-2">
        {known.map((k, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input className={field} placeholder="Name" value={k.name} onChange={(e) => setKnown(known.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input className={field} placeholder="Owner" value={k.owner ?? ''} onChange={(e) => setKnown(known.map((x, j) => (j === i ? { ...x, owner: e.target.value } : x)))} />
            <input className={field} placeholder="Note" value={k.note ?? ''} onChange={(e) => setKnown(known.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
            <button className={btn} onClick={() => setKnown(known.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button className={btn} onClick={() => setKnown([...known, { name: '', owner: '', note: '' }])}>Add a known mark</button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className={btnPrimary} disabled={busy || !mark.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save intake'}</button>
        {saved && <span className="text-[12px] text-[#86e0a8]">Saved.</span>}
      </div>
      <ErrorLine text={error} />
      <SignOff b={b} stage={1} initials={initials} setInitials={setInitials} onChanged={onChanged}
        blocked={!c.mark.trim() ? 'Save the mark first.' : null} />
    </Panel>
  );
}
