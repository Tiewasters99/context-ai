import { useState } from 'react';
import { Send, FileText, Check, ChevronDown, Loader2, Copy, Download } from 'lucide-react';

interface ContextFile {
  id: string;
  name: string;
  selected: boolean;
}

const availableFiles: ContextFile[] = [
  { id: 'f1', name: 'Smith_v_Jones_Opinion.pdf', selected: false },
  { id: 'f2', name: 'Labib_Letterhead.docx', selected: true },
  { id: 'f3', name: 'Case_Alpha_Discovery.pdf', selected: false },
  { id: 'f4', name: 'Opposing_Counsel_Correspondence.pdf', selected: true },
  { id: 'f5', name: 'Settlement_Demand_Template.docx', selected: true },
  { id: 'f6', name: 'Expert_Report_Williams.pdf', selected: false },
];

const models = [
  { id: 'opus', name: 'Claude Opus 4.6', description: 'Most capable — complex reasoning, long documents', tier: 'Pro' },
  { id: 'sonnet', name: 'Claude Sonnet 4.6', description: 'Fast and capable — great for most tasks', tier: 'Free' },
  { id: 'byok', name: 'Bring Your Own Key', description: 'Use your own API key for any model', tier: 'Pro' },
];

const mockOutput = `**LABIB LAW OFFICES**
123 Main Street, Suite 400
New York, NY 10001
Tel: (212) 555-0100

April 7, 2026

VIA EMAIL AND CERTIFIED MAIL

Robert J. Hartfield, Esq.
Hartfield & Associates
456 Park Avenue, 12th Floor
New York, NY 10022

Re: *Smith v. Jones* — Case No. 2025-CV-04821
     Settlement Demand

Dear Mr. Hartfield:

We represent the Plaintiff in the above-referenced matter. As you are aware, this case involves claims of breach of fiduciary duty and fraudulent misrepresentation arising from your client's management of our client's investment portfolio.

**FACTUAL BACKGROUND**

Based on our review of the discovery materials produced to date, including the Expert Report of Dr. Williams (attached as Exhibit A), the evidence overwhelmingly supports our client's position. Specifically:

1. Your client failed to disclose material conflicts of interest in violation of SEC Rule 10b-5, as established in *Smith v. Jones*, 487 F.3d 892 (2d Cir. 2024);

2. The forensic accounting analysis demonstrates damages in excess of $2,400,000, representing the difference between the portfolio's projected performance under prudent management and its actual performance under your client's stewardship;

3. Contemporaneous communications produced in discovery confirm your client's awareness of the risks that were concealed from our client.

**DEMAND**

In light of the foregoing, and to avoid the significant expense and uncertainty of continued litigation, we hereby demand settlement in the amount of **$2,400,000.00**, inclusive of attorneys' fees and costs.

This demand will remain open for thirty (30) calendar days from the date of this letter. Should we not reach a resolution within that period, we intend to proceed with a motion for summary judgment on the fraud claims.

We look forward to your prompt response.

Very truly yours,

**LABIB LAW OFFICES**

___________________________
Senior Partner`;

export default function AIWorkbench() {
  const [contextFiles, setContextFiles] = useState(availableFiles);
  const [selectedModel, setSelectedModel] = useState('opus');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [output, setOutput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [showFileSelector, setShowFileSelector] = useState(false);

  const selectedCount = contextFiles.filter((f) => f.selected).length;
  const currentModel = models.find((m) => m.id === selectedModel)!;

  const toggleFile = (id: string) => {
    setContextFiles((prev) => prev.map((f) => f.id === id ? { ...f, selected: !f.selected } : f));
  };

  const handleGenerate = () => {
    if (!instruction.trim()) return;
    setGenerating(true);
    setOutput('');

    // Simulate streaming output
    let i = 0;
    const interval = setInterval(() => {
      i += Math.floor(Math.random() * 8) + 3;
      if (i >= mockOutput.length) {
        setOutput(mockOutput);
        setGenerating(false);
        clearInterval(interval);
      } else {
        setOutput(mockOutput.slice(0, i));
      }
    }, 20);
  };

  return (
    <div className="flex-1 flex h-full overflow-hidden">
      {/* Left: Instruction panel */}
      <div className="w-[400px] shrink-0 flex flex-col border-r border-[rgba(255,255,255,0.08)]">
        <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.08)]">
          <h2 className="text-[16px] font-semibold text-white mb-1">AI Workbench</h2>
          <p className="text-[12px] text-white/50">Select context, choose a model, give instructions.</p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Context files */}
          <div>
            <button
              onClick={() => setShowFileSelector(!showFileSelector)}
              className="flex items-center justify-between w-full text-left"
            >
              <h3 className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">
                Context ({selectedCount} files)
              </h3>
              <ChevronDown size={14} className={`text-white/30 transition-transform ${showFileSelector ? 'rotate-180' : ''}`} />
            </button>

            {showFileSelector && (
              <div className="mt-2 space-y-0.5">
                {contextFiles.map((file) => (
                  <button
                    key={file.id}
                    onClick={() => toggleFile(file.id)}
                    className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md hover:bg-[rgba(255,255,255,0.04)] transition-colors text-left"
                  >
                    <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                      file.selected ? 'bg-[#e8b84a] border-[#e8b84a]' : 'border-white/20'
                    }`}>
                      {file.selected && <Check size={10} className="text-black" strokeWidth={3} />}
                    </div>
                    <FileText size={13} className="text-white/30 shrink-0" />
                    <span className="text-[12px] text-white/70 truncate">{file.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Model selector */}
          <div>
            <h3 className="text-[11px] font-semibold text-white/50 uppercase tracking-wider mb-2">Model</h3>
            <div className="relative">
              <button
                onClick={() => setShowModelDropdown(!showModelDropdown)}
                className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] hover:border-[rgba(255,255,255,0.14)] transition-colors"
              >
                <div>
                  <span className="text-[13px] text-white block">{currentModel.name}</span>
                  <span className="text-[10px] text-white/30">{currentModel.description}</span>
                </div>
                <ChevronDown size={14} className={`text-white/30 transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showModelDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#0a0a10] z-10 overflow-hidden">
                  {models.map((model) => (
                    <button
                      key={model.id}
                      onClick={() => { setSelectedModel(model.id); setShowModelDropdown(false); }}
                      className={`flex items-center justify-between w-full px-3 py-2.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors ${
                        selectedModel === model.id ? 'bg-[rgba(255,255,255,0.03)]' : ''
                      }`}
                    >
                      <div>
                        <span className="text-[12px] text-white block">{model.name}</span>
                        <span className="text-[10px] text-white/30">{model.description}</span>
                      </div>
                      <span className="text-[9px] text-[#e8b84a]/60 uppercase">{model.tier}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Instruction */}
          <div>
            <h3 className="text-[11px] font-semibold text-white/50 uppercase tracking-wider mb-2">Instruction</h3>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g., Using my Labib letterhead, draft a demand letter to opposing counsel Robert Hartfield citing the Smith v. Jones precedent. Demand $2.4M based on the expert report findings."
              rows={6}
              className="w-full px-3 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[13px] text-white placeholder-white/25 resize-none focus:outline-none focus:ring-1 focus:ring-[#e8b84a] focus:border-transparent"
            />
          </div>
        </div>

        {/* Generate button */}
        <div className="px-5 py-4 border-t border-[rgba(255,255,255,0.08)]">
          <button
            onClick={handleGenerate}
            disabled={!instruction.trim() || generating}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-lg bg-[#e8b84a] hover:bg-[#d4a054] text-black text-[13px] font-bold transition-colors disabled:opacity-40 shadow-[0_0_20px_rgba(232,184,74,0.15)]"
          >
            {generating ? (
              <><Loader2 size={15} className="animate-spin" /> Generating...</>
            ) : (
              <><Send size={15} /> Generate</>
            )}
          </button>
        </div>
      </div>

      {/* Right: Output */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-white">Output</h3>
          {output && (
            <div className="flex items-center gap-2">
              <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white text-[11px] transition-colors">
                <Copy size={12} /> Copy
              </button>
              <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white text-[11px] transition-colors">
                <Download size={12} /> Save to Vault
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6">
          {output ? (
            <div className="max-w-2xl">
              <pre className="text-[13px] text-white/90 whitespace-pre-wrap font-[inherit] leading-relaxed">
                {output}
                {generating && <span className="inline-block w-0.5 h-4 bg-[#e8b84a] ml-0.5 animate-pulse" />}
              </pre>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-[13px] text-white/15">Output will appear here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
