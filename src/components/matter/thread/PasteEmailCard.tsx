// "Paste an email": the client (or anyone) copies an email out of their mail
// or their own AI, pastes it here, and it is saved into this conversation as
// correspondence — From / To / Cc / Date / Subject shown as a header, the
// quoted history below it kept apart and shown collapsed. Files dropped with
// it are filed into the matter's Vault and linked from the message, except in
// a private conversation, where filing them would put them in front of
// everyone on the matter.
//
// House rule: a card is draggable, resizable and pinnable (AgentCard's shell,
// the same hook as every other card).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Lock, Paperclip, X } from 'lucide-react';
import AgentCard, { cardField, cardLegend } from '@/components/agents/AgentCard';
import { parsePastedEmail } from '../../../../lib/email-paste.mjs';
import { PRIVATE_ATTACHMENTS_NOTE, type ConversationRow } from '@/lib/conversations';
import { checkUploadAdmissible, persistVaultFile, resolveMatter } from '@/lib/vault-persist';
import { postMessage } from './api';

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function PasteEmailCard({
  matterId,
  conversation,
  viewerId,
  onClose,
  onSaved,
}: {
  matterId: string;
  conversation: ConversationRow;
  viewerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isPrivate = conversation.audience === 'members';
  const [raw, setRaw] = useState('');
  const [separateQuoted, setSeparateQuoted] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [date, setDate] = useState('');
  const [dateText, setDateText] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [quoted, setQuoted] = useState<string | null>(null);
  const [showQuoted, setShowQuoted] = useState(false);
  const [repaired, setRepaired] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Read the paste every time it (or the quote choice) changes. The fields
  // below stay editable: the parser never guesses, and the person corrects.
  useEffect(() => {
    if (!raw.trim()) return;
    const e = parsePastedEmail(raw, { separateQuoted });
    setFrom(e.from ?? '');
    setTo(e.to ?? '');
    setCc(e.cc ?? '');
    setSubject(e.subject ?? '');
    setDate(toLocalInput(e.date));
    setDateText(e.dateText);
    setBody(e.body);
    setQuoted(e.quoted);
    setRepaired(e.repaired);
  }, [raw, separateQuoted]);

  const dateUnread = useMemo(() => !!dateText && !date, [dateText, date]);
  const canSave = !!body.trim() && !saving;

  const addFiles = (list: FileList | null) => {
    if (!list || isPrivate) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  };

  const save = async () => {
    if (!canSave) return;
    setError(null);
    try {
      const attachmentIds: string[] = [];
      if (files.length && !isPrivate) {
        const matter = await resolveMatter(matterId);
        if (!matter) throw new Error('This matter could not be read, so the files were not filed.');
        for (const [i, file] of files.entries()) {
          setSaving(`Filing ${i + 1} of ${files.length} in the Vault…`);
          const refusal = await checkUploadAdmissible(matter, file);
          if (refusal) {
            if (refusal.code === 'duplicate') { attachmentIds.push(refusal.existingId); continue; }
            throw new Error(refusal.message);
          }
          const { documentId } = await persistVaultFile(matter, file);
          attachmentIds.push(documentId);
        }
      }
      setSaving('Saving the email…');
      const iso = date ? new Date(date).toISOString() : null;
      await postMessage({
        matterId,
        conversationId: conversation.id,
        userId: viewerId,
        body: body.trim(),
        attachmentIds,
        email: {
          from: from.trim() || null,
          to: to.trim() || null,
          cc: cc.trim() || null,
          date: iso,
          subject: subject.trim() || null,
          quoted: separateQuoted ? quoted : null,
        },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(null);
    }
  };

  const field = (label: string, value: string, set: (v: string) => void, placeholder = '') => (
    <label className="block">
      <span className={cardLegend}>{label}</span>
      <input value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} className={cardField} />
    </label>
  );

  return (
    <AgentCard
      storageKey={`cs.thread.paste-email:${matterId}`}
      title="Paste an email"
      subtitle={`Saved to “${conversation.title}”${isPrivate ? ' — a private conversation' : ''}.`}
      maxWidth={720}
      onClose={onClose}
      footer={(
        <>
          {error && <p className="text-[11.5px] text-red-300 mr-auto">{error}</p>}
          {saving && !error && <p className="text-[11.5px] text-white/50 mr-auto">{saving}</p>}
          <button onClick={onClose} className="ml-auto px-3 py-1.5 rounded-lg text-[12.5px] text-white/60 hover:text-white hover:bg-white/5">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium border border-[#e8b84a]/35 bg-[#e8b84a]/10 text-[#e8b84a] hover:bg-[#e8b84a]/20 disabled:opacity-35 disabled:cursor-not-allowed"
          >
            Save to conversation
          </button>
        </>
      )}
    >
      <div>
        <p className={cardLegend}>The email, as copied</p>
        <textarea
          autoFocus
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={6}
          placeholder="Paste the whole email here — headers and all, or a forward. From, To, Cc, Date and Subject are read from it."
          className={`${cardField} resize-y font-mono text-[12px]`}
        />
        <label className="flex items-center gap-2 mt-2 text-[12px] text-white/70 cursor-pointer">
          <input type="checkbox" checked={separateQuoted} onChange={(e) => setSeparateQuoted(e.target.checked)} className="accent-[#e8b84a]" />
          Keep the earlier emails quoted below it separate (shown collapsed)
        </label>
        {repaired && (
          <p className="text-[11px] text-white/45 mt-1">Garbled characters from the copy (such as â€™) were repaired.</p>
        )}
      </div>

      {raw.trim() && (
        <>
          <p className="text-[11.5px] text-white/50">Check the fields below; anything that could not be read is left blank.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {field('From', from, setFrom)}
            <label className="block">
              <span className={cardLegend}>Date</span>
              <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} className={cardField} />
              {dateUnread && <span className="text-[11px] text-amber-300/80">Could not read “{dateText}”. Enter the date.</span>}
            </label>
            {field('To', to, setTo)}
            {field('Cc', cc, setCc)}
          </div>
          {field('Subject', subject, setSubject)}
          <label className="block">
            <span className={cardLegend}>Message</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={`${cardField} resize-y`} />
          </label>
          {quoted && separateQuoted && (
            <div className="rounded-lg border border-white/10">
              <button onClick={() => setShowQuoted((v) => !v)} className="w-full text-left px-3 py-2 text-[12px] text-white/60 hover:text-white">
                {showQuoted ? 'Hide' : 'Show'} the quoted history ({quoted.split('\n').length} lines) — saved with the email, shown collapsed
              </button>
              {showQuoted && (
                <pre className="px-3 pb-3 text-[11.5px] text-white/55 whitespace-pre-wrap break-words max-h-56 overflow-y-auto">{quoted}</pre>
              )}
            </div>
          )}
        </>
      )}

      <div>
        <p className={cardLegend}>Attachments</p>
        {isPrivate ? (
          <p className="flex items-start gap-2 text-[11.5px] text-white/55 leading-relaxed">
            <Lock size={12} className="mt-0.5 shrink-0" /> {PRIVATE_ATTACHMENTS_NOTE}
          </p>
        ) : (
          <>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
              onClick={() => fileInput.current?.click()}
              className={`rounded-lg border border-dashed px-3 py-4 text-center text-[12px] cursor-pointer transition-colors ${
                dragOver ? 'border-[#e8b84a]/60 bg-[#e8b84a]/5 text-[#e8b84a]' : 'border-white/15 text-white/50 hover:text-white/75'
              }`}
            >
              <Paperclip size={13} className="inline mr-1.5 -mt-0.5" />
              Drop the email’s attachments here, or click to choose. They are filed in this matter’s Vault and linked from the email.
            </div>
            {!conversation.ai_readable && (
              <p className="text-[11px] text-amber-300/80 mt-1.5 leading-relaxed">
                This conversation is closed to AI, but files filed in the Vault follow the Vault’s rules: AI can read them wherever the matter allows it.
              </p>
            )}
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-[12px] text-white/75">
                    <span className="truncate">{f.name}</span>
                    <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-white/40 hover:text-white" aria-label={`Remove ${f.name}`}>
                      <X size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </AgentCard>
  );
}
