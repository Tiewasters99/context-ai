// "Matter Record" — one button, two files.
//
// The export is assembled from the Record that has already been read into the
// tab: no model, no second query, no document text. The attorney picks a
// jurisdiction (optional) and gets a .md and a .docx, or files both into the
// matter so the record of the Record lives with it.
//
// PDF is deliberately absent: the repo has no client-side laid-out-text PDF
// writer, and a .docx a lawyer prints is better than a PDF hand-rolled here.

import { useState } from 'react';
import { Download, FileText, FolderInput } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  buildMatterRecordDoc,
  jurisdictionOptions,
  loadJurisdictions,
  matterRecordFilename,
  matterRecordDocxBlob,
  renderMatterRecordMarkdown,
} from '@/lib/matter-record';
import { isoDay } from '@/lib/matter-record/describe';
import type {
  ExportContext,
  JurisdictionMatrix,
  MatterRecordData,
  MatterRef,
} from '@/lib/matter-record/types';
import { persistVaultFile, resolveMatter } from '@/lib/vault-persist';

interface Props {
  matter: MatterRef;
  data: MatterRecordData;
}

const BUTTON_CLASS =
  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] ' +
  'text-[13px] text-white/80 hover:bg-[#1c1c26] hover:text-white transition-colors ' +
  'disabled:opacity-40 disabled:hover:bg-transparent';

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filed copy carries the minute, so two exports on one day do not collide. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return isoDay(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16).replace(':', '')}Z`;
}

export default function MatterRecordExport({ matter, data }: Props) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [matrix, setMatrix] = useState<JurisdictionMatrix | null>(null);
  const [jurisdictionId, setJurisdictionId] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const exporterName =
    (typeof user?.user_metadata?.display_name === 'string' &&
      user.user_metadata.display_name.trim()) ||
    user?.email ||
    'not recorded';

  const openPanel = async () => {
    setOpen((was) => !was);
    if (matrix) return;
    try {
      setMatrix(await loadJurisdictions());
    } catch {
      // The rules matrix is a convenience; the record exports without it.
      setStatus('The rules matrix could not be loaded; the export will omit section 8.');
    }
  };

  const context = (): ExportContext => ({
    generatedAt: new Date().toISOString(),
    generatedBy: exporterName,
    jurisdictionId: jurisdictionId || null,
  });

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setStatus(null);
    try {
      await work();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The export failed.');
    } finally {
      setBusy(null);
    }
  };

  const downloadMarkdown = () =>
    run('md', async () => {
      const ctx = context();
      const doc = buildMatterRecordDoc(data, ctx, matrix);
      const markdown = renderMatterRecordMarkdown(doc);
      download(
        new Blob([markdown], { type: 'text/markdown' }),
        matterRecordFilename(matter.name, isoDay(ctx.generatedAt), '.md'),
      );
      setStatus('Downloaded.');
    });

  const downloadDocx = () =>
    run('docx', async () => {
      const ctx = context();
      const doc = buildMatterRecordDoc(data, ctx, matrix);
      const blob = await matterRecordDocxBlob(doc);
      download(blob, matterRecordFilename(matter.name, isoDay(ctx.generatedAt), '.docx'));
      setStatus('Downloaded.');
    });

  const fileIntoMatter = () =>
    run('file', async () => {
      const ctx = context();
      const doc = buildMatterRecordDoc(data, ctx, matrix);
      const markdown = renderMatterRecordMarkdown(doc);
      const docx = await matterRecordDocxBlob(doc);
      const when = stamp(ctx.generatedAt);

      const ref = await resolveMatter(matter.id);
      if (!ref) throw new Error('This matter could not be opened for filing.');

      const mdName = matterRecordFilename(matter.name, when, '.md');
      const docxName = matterRecordFilename(matter.name, when, '.docx');
      await persistVaultFile(ref, new File([markdown], mdName, { type: 'text/markdown' }));
      await persistVaultFile(
        ref,
        new File([docx], docxName, {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      );
      setStatus(`Filed into ${ref.name}: ${mdName} and ${docxName}.`);
    });

  return (
    <div className="relative">
      <button onClick={openPanel} className={BUTTON_CLASS}>
        <FileText size={12} strokeWidth={2} /> Matter Record
      </button>

      {open && (
        <div className="absolute right-0 mt-2 z-20 w-[340px] rounded-lg border border-[rgba(255,255,255,0.14)] bg-[#12121a] p-4 shadow-xl">
          <p className="text-[13px] text-[#f5f1e8]">Matter Record</p>
          <p className="text-[12px] text-white/45 mt-1 leading-snug">
            Everything recorded on {matter.name}
            {data.matters.length > 1 ? ' and its sub-matters' : ''}: the models used and on what
            terms, each session, connector activity, access and seal changes, cite-check runs,
            and the chain check. Counsel's cells are left blank.
          </p>

          <label className="block text-[11px] uppercase tracking-wider text-white/35 mt-4 mb-1">
            Jurisdiction (optional)
          </label>
          <select
            className="w-full bg-[#0d0d14] border border-[rgba(255,255,255,0.14)] rounded-md px-2.5 py-1.5 text-[13px] text-[#f5f1e8] focus:outline-none focus:border-[#e8b84a]/60"
            value={jurisdictionId}
            onChange={(e) => setJurisdictionId(e.target.value)}
            disabled={!matrix}
          >
            <option value="">None — omit the rules section</option>
            {matrix &&
              jurisdictionOptions(matrix).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.status})
                </option>
              ))}
          </select>
          {matrix && (
            <p className="text-[11px] text-white/35 mt-1">
              Rules matrix {matrix.matrix_version}, printed verbatim.
            </p>
          )}

          <div className="flex flex-wrap gap-2 mt-4">
            <button onClick={downloadMarkdown} disabled={!!busy} className={BUTTON_CLASS}>
              <Download size={12} strokeWidth={2} /> {busy === 'md' ? 'Working…' : '.md'}
            </button>
            <button onClick={downloadDocx} disabled={!!busy} className={BUTTON_CLASS}>
              <Download size={12} strokeWidth={2} /> {busy === 'docx' ? 'Working…' : '.docx'}
            </button>
            <button onClick={fileIntoMatter} disabled={!!busy} className={BUTTON_CLASS}>
              <FolderInput size={12} strokeWidth={2} />
              {busy === 'file' ? 'Filing…' : 'File into this matter'}
            </button>
          </div>

          {status && <p className="text-[12px] text-white/60 mt-3 leading-snug">{status}</p>}
        </div>
      )}
    </div>
  );
}
