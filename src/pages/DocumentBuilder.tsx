// Document Builder — a workspace for composing finished documents from
// sources, then exporting them or filing them into the right place in
// Contextspaces. Conceived as a matter-like space whose contents are
// organised by document *type* (Books, prospectuses, financial reports,
// manuals, …) rather than by legal matter.
//
// PLACEHOLDER: this surface is intentionally a stub for now. It captures
// the intended shape (document types + build → export/file flow) so the
// navigation entry exists; the build/compose tooling is not yet wired.

import { FileStack, BookOpen, TrendingUp, FileBarChart, BookText, ArrowUpRight, FolderInput } from 'lucide-react';

const DOC_TYPES: { icon: typeof BookOpen; name: string; blurb: string }[] = [
  { icon: BookOpen, name: 'Books', blurb: 'Long-form works — scanned editions, manuscripts, references.' },
  { icon: TrendingUp, name: 'Prospectuses', blurb: 'Offering documents and disclosures.' },
  { icon: FileBarChart, name: 'Financial reports', blurb: 'Statements, filings, and periodic reporting.' },
  { icon: BookText, name: 'Manuals', blurb: 'Guides, handbooks, and operating documentation.' },
];

export default function DocumentBuilder() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex items-start gap-3 mb-2">
        <div className="w-10 h-10 rounded-lg bg-[rgba(212,160,84,0.1)] flex items-center justify-center shrink-0 mt-0.5">
          <FileStack size={20} className="text-[#d4a054]" strokeWidth={1.75} />
        </div>
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-semibold text-white tracking-tight">Document Builder</h1>
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[rgba(255,255,255,0.06)] text-white/50 border border-[rgba(255,255,255,0.1)]">
              Coming soon
            </span>
          </div>
          <p className="text-[14px] text-white/55 leading-relaxed mt-1">
            Compose finished documents from your sources, then export them or file
            them into the right place in Contextspaces.
          </p>
        </div>
      </div>

      {/* Document types */}
      <div className="mt-9">
        <h2 className="text-[11px] font-semibold text-white/40 uppercase tracking-wider mb-3">
          Document types
        </h2>
        <div className="border border-[rgba(255,255,255,0.08)] rounded-xl overflow-hidden divide-y divide-[rgba(255,255,255,0.06)]">
          {DOC_TYPES.map(({ icon: Icon, name, blurb }) => (
            <div key={name} className="flex items-center gap-3.5 px-4 py-3.5 hover:bg-[rgba(255,255,255,0.02)] transition-colors">
              <Icon size={18} className="text-white/45 shrink-0" strokeWidth={1.75} />
              <div className="min-w-0">
                <div className="text-[14px] text-white font-medium">{name}</div>
                <div className="text-[12.5px] text-white/45 truncate">{blurb}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Build → destination flow */}
      <div className="mt-8">
        <h2 className="text-[11px] font-semibold text-white/40 uppercase tracking-wider mb-3">
          Once a document is built
        </h2>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 flex items-center gap-3 px-4 py-3.5 rounded-xl border border-[rgba(255,255,255,0.08)]">
            <ArrowUpRight size={18} className="text-[#d4a054] shrink-0" strokeWidth={1.75} />
            <div>
              <div className="text-[14px] text-white font-medium">Export</div>
              <div className="text-[12.5px] text-white/45">Download as a finished file.</div>
            </div>
          </div>
          <div className="flex-1 flex items-center gap-3 px-4 py-3.5 rounded-xl border border-[rgba(255,255,255,0.08)]">
            <FolderInput size={18} className="text-[#d4a054] shrink-0" strokeWidth={1.75} />
            <div>
              <div className="text-[14px] text-white font-medium">File into Contextspaces</div>
              <div className="text-[12.5px] text-white/45">Route to the appropriate matter or sub-matter.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
