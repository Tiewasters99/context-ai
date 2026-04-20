import { useState, useRef, useCallback, useMemo } from 'react';
import { Send, FileText, Check, ChevronDown, Copy, Download, Square, AlertCircle, Info, Search, Zap } from 'lucide-react';
import { generate, allModels, estimateTokens } from '@/lib/llm';
import { searchVaultFiles, autoSelectFiles } from '@/lib/search';
import type { VaultFile } from '@/lib/vault-types';
import type { SearchResult } from '@/lib/search';

interface AIWorkbenchProps {
  vaultFiles: VaultFile[];
}

type Mode = 'manual' | 'auto';

export default function AIWorkbench({ vaultFiles }: AIWorkbenchProps) {
  const models = useMemo(() => allModels(), []);
  const [selectedModelId, setSelectedModelId] = useState('claude-opus');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [output, setOutput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [routingInfo, setRoutingInfo] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>('auto');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const currentModel = models.find((m) => m.id === selectedModelId) ?? models[0];
  const indexedFiles = vaultFiles.filter((f) => f.status === 'indexed' && f.textContent);

  const toggleFileSelection = (id: string) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedFileIds(new Set(indexedFiles.map((f) => f.id)));
  const deselectAll = () => setSelectedFileIds(new Set());

  const manualSelected = indexedFiles.filter((f) => selectedFileIds.has(f.id));
  const selectedTokens = manualSelected.reduce((sum, f) => sum + estimateTokens(f.textContent ?? ''), 0);
  const fitsInContext = selectedTokens < currentModel.contextWindow * 0.8;

  // Run local search when instruction changes (debounced feel with auto mode)
  const runSearch = useCallback(() => {
    if (!instruction.trim() || indexedFiles.length === 0) {
      setSearchResults(null);
      return;
    }
    const results = searchVaultFiles(indexedFiles, instruction);
    setSearchResults(results.length > 0 ? results : null);
  }, [instruction, indexedFiles]);

  const handleGenerate = useCallback(async () => {
    if (!instruction.trim() || generating) return;
    setGenerating(true);
    setOutput('');
    setError('');
    setRoutingInfo('');

    const controller = new AbortController();
    abortRef.current = controller;

    let contextFiles: { name: string; content: string }[];

    if (mode === 'auto') {
      // Auto-select relevant files based on the instruction
      const reservedTokens = estimateTokens(instruction) + 2000;
      const available = currentModel.contextWindow - reservedTokens - 4096;
      const { selected, totalTokens } = autoSelectFiles(indexedFiles, instruction, available);

      if (selected.length === 0 && indexedFiles.length > 0) {
        // No keyword matches — send first few files that fit
        contextFiles = [];
        let budget = available;
        for (const f of indexedFiles) {
          const t = estimateTokens(f.textContent ?? '');
          if (budget - t < 0) break;
          contextFiles.push({ name: f.name, content: f.textContent ?? '' });
          budget -= t;
        }
        setRoutingInfo(`No strong keyword matches — sending ${contextFiles.length} files (~${Math.round((available - budget) / 1000)}K tokens)`);
      } else {
        contextFiles = selected.map((f) => ({ name: f.name, content: f.textContent ?? '' }));
        setRoutingInfo(`Auto-selected ${selected.length} relevant file${selected.length !== 1 ? 's' : ''} (~${Math.round(totalTokens / 1000)}K tokens)`);
      }
    } else {
      // Manual mode — use explicitly selected files
      contextFiles = manualSelected.map((f) => ({ name: f.name, content: f.textContent ?? '' }));
    }

    const result = await generate({
      modelId: selectedModelId,
      instruction,
      contextFiles,
      signal: controller.signal,
      callbacks: {
        onChunk: (text) => setOutput((prev) => prev + text),
        onDone: () => { setGenerating(false); abortRef.current = null; },
        onError: (err) => { setError(err); setGenerating(false); abortRef.current = null; },
      },
    });

    if (result?.message) {
      setRoutingInfo((prev) => prev + (prev ? ' · ' : '') + result.message);
    }
  }, [instruction, generating, manualSelected, indexedFiles, selectedModelId, currentModel, mode]);

  const handleStop = () => {
    abortRef.current?.abort();
    setGenerating(false);
    abortRef.current = null;
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = () => {
    const blob = new Blob([output], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vault-output-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex-1 flex h-full overflow-hidden">
      {/* Left: Instruction panel */}
      <div className="w-[400px] shrink-0 flex flex-col border-r border-[rgba(255,255,255,0.08)]">
        <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.08)]">
          <h2 className="text-[16px] font-semibold text-white mb-1">AI Workbench</h2>
          <p className="text-[12px] text-white/80">Describe what you need — we'll find the right files and get to work.</p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Instruction — moved to top for auto mode */}
          <div>
            <h3 className="text-[11px] font-semibold text-white/80 uppercase tracking-wider mb-2">Instruction</h3>
            <textarea
              value={instruction}
              onChange={(e) => { setInstruction(e.target.value); if (mode === 'auto') runSearch(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
              placeholder="e.g., Search for recent correspondence with Judge Willis, then draft a letter dated today on my letterhead explaining the status of depositions ordered by the court."
              rows={5}
              className="w-full px-3 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[13px] text-white placeholder-white/25 resize-none focus:outline-none focus:ring-1 focus:ring-[#e8b84a] focus:border-transparent"
            />
            <p className="text-[10px] text-white/70 mt-1">Ctrl+Enter to generate</p>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setMode('auto'); runSearch(); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors ${
                mode === 'auto' ? 'bg-[#e8b84a] text-black' : 'bg-[rgba(255,255,255,0.06)] text-white/70 hover:bg-[rgba(255,255,255,0.1)]'
              }`}
            >
              <Zap size={11} /> Auto-select files
            </button>
            <button
              onClick={() => setMode('manual')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors ${
                mode === 'manual' ? 'bg-[#e8b84a] text-black' : 'bg-[rgba(255,255,255,0.06)] text-white/70 hover:bg-[rgba(255,255,255,0.1)]'
              }`}
            >
              <FileText size={11} /> Manual
            </button>
          </div>

          {/* Auto mode: search preview */}
          {mode === 'auto' && searchResults && (
            <div>
              <h3 className="text-[11px] font-semibold text-white/80 uppercase tracking-wider mb-2">
                <Search size={10} className="inline mr-1" />
                Matching Files ({searchResults.length})
              </h3>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {searchResults.slice(0, 8).map((r) => (
                  <div key={r.file.id} className="px-2.5 py-2 rounded-md bg-[rgba(255,255,255,0.03)]">
                    <div className="flex items-center gap-2">
                      <FileText size={12} className="text-[#e8b84a] shrink-0" />
                      <span className="text-[11px] text-white/80 truncate">{r.file.name}</span>
                      <span className="text-[9px] text-white/30 shrink-0 ml-auto">{r.score} hits</span>
                    </div>
                    {r.excerpt && (
                      <p className="text-[10px] text-white/40 mt-1 line-clamp-2">{r.excerpt}</p>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-emerald-400/80 mt-2">
                These files will be sent to {currentModel.name} automatically.
              </p>
            </div>
          )}

          {mode === 'auto' && !searchResults && indexedFiles.length > 0 && instruction.trim() && (
            <p className="text-[10px] text-white/50">
              <Search size={10} className="inline mr-1" />
              No keyword matches — all files that fit will be sent.
            </p>
          )}

          {mode === 'auto' && indexedFiles.length === 0 && (
            <p className="text-[10px] text-white/50">No files imported yet. Go to Import Documents first.</p>
          )}

          {/* Manual mode: file selector */}
          {mode === 'manual' && (
            <div>
              <button
                onClick={() => setShowFileSelector(!showFileSelector)}
                className="flex items-center justify-between w-full text-left"
              >
                <h3 className="text-[11px] font-semibold text-white/80 uppercase tracking-wider">
                  Context ({selectedFileIds.size} of {indexedFiles.length} files)
                </h3>
                <ChevronDown size={14} className={`text-white/70 transition-transform ${showFileSelector ? 'rotate-180' : ''}`} />
              </button>

              {showFileSelector && (
                <div className="mt-2 space-y-0.5">
                  {indexedFiles.length === 0 ? (
                    <p className="text-[11px] text-white/70 px-2.5 py-2">No files imported yet.</p>
                  ) : (
                    <>
                      <div className="flex gap-2 px-2.5 py-1">
                        <button onClick={selectAll} className="text-[10px] text-[#e8b84a]/80 hover:text-[#e8b84a] transition-colors">Select all</button>
                        <button onClick={deselectAll} className="text-[10px] text-white/40 hover:text-white/60 transition-colors">Clear</button>
                      </div>
                      {indexedFiles.map((file) => (
                        <button
                          key={file.id}
                          onClick={() => toggleFileSelection(file.id)}
                          className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md hover:bg-[rgba(255,255,255,0.04)] transition-colors text-left"
                        >
                          <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                            selectedFileIds.has(file.id) ? 'bg-[#e8b84a] border-[#e8b84a]' : 'border-white/20'
                          }`}>
                            {selectedFileIds.has(file.id) && <Check size={10} className="text-black" strokeWidth={3} />}
                          </div>
                          <FileText size={13} className="text-white/70 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <span className="text-[12px] text-white/80 truncate block">{file.name}</span>
                            <span className="text-[9px] text-white/40">{file.size} · ~{Math.round(estimateTokens(file.textContent ?? '') / 1000)}K tokens</span>
                          </div>
                        </button>
                      ))}
                    </>
                  )}

                  {selectedFileIds.size > 0 && (
                    <div className={`flex items-center gap-1.5 px-2.5 py-1.5 mt-1 rounded text-[10px] ${
                      fitsInContext ? 'text-emerald-400/80' : 'text-amber-400/80'
                    }`}>
                      <Info size={10} />
                      {fitsInContext
                        ? `~${Math.round(selectedTokens / 1000)}K tokens — fits in ${currentModel.name}`
                        : `~${Math.round(selectedTokens / 1000)}K tokens — exceeds ${currentModel.name}'s ${Math.round(currentModel.contextWindow / 1000)}K window. Relevant sections will be auto-selected.`
                      }
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Model selector */}
          <div>
            <h3 className="text-[11px] font-semibold text-white/80 uppercase tracking-wider mb-2">Model</h3>
            <div className="relative">
              <button
                onClick={() => setShowModelDropdown(!showModelDropdown)}
                className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] hover:border-[rgba(255,255,255,0.14)] transition-colors"
              >
                <div>
                  <span className="text-[13px] text-white block">{currentModel.name}</span>
                  <span className="text-[10px] text-white/70">{currentModel.description}</span>
                </div>
                <ChevronDown size={14} className={`text-white/70 transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showModelDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#0a0a10] z-10 overflow-hidden max-h-72 overflow-y-auto">
                  {models.map((model) => (
                    <button
                      key={model.id}
                      onClick={() => { setSelectedModelId(model.id); setShowModelDropdown(false); }}
                      className={`flex items-center justify-between w-full px-3 py-2.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors ${
                        selectedModelId === model.id ? 'bg-[rgba(255,255,255,0.03)]' : ''
                      }`}
                    >
                      <div>
                        <span className="text-[12px] text-white block">{model.name}</span>
                        <span className="text-[10px] text-white/70">{model.description}</span>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <span className="text-[9px] text-[#e8b84a]/60 uppercase block">{model.tier}</span>
                        <span className="text-[8px] text-white/30">{Math.round(model.contextWindow / 1000)}K ctx</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Generate / Stop */}
        <div className="px-5 py-4 border-t border-[rgba(255,255,255,0.08)]">
          {generating ? (
            <button
              onClick={handleStop}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-lg bg-red-500/80 hover:bg-red-500 text-white text-[13px] font-bold transition-colors"
            >
              <Square size={13} fill="currentColor" /> Stop
            </button>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={!instruction.trim()}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[13px] font-bold transition-colors disabled:opacity-40 shadow-[0_0_20px_rgba(240,200,80,0.25)]"
            >
              <Send size={15} /> Generate
            </button>
          )}
        </div>
      </div>

      {/* Right: Output */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between">
          <div>
            <h3 className="text-[14px] font-semibold text-white">Output</h3>
            {routingInfo && (
              <p className="text-[10px] text-white/50 mt-0.5">{routingInfo}</p>
            )}
          </div>
          {output && !generating && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.06)] text-white/80 hover:text-white text-[11px] transition-colors"
              >
                {copied ? <><Check size={12} className="text-emerald-400" /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.06)] text-white/80 hover:text-white text-[11px] transition-colors"
              >
                {saved ? <><Check size={12} className="text-emerald-400" /> Saved</> : <><Download size={12} /> Save</>}
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6">
          {error ? (
            <div className="flex items-start gap-3 max-w-2xl">
              <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-[13px] text-red-400 font-medium mb-1">Generation failed</p>
                <p className="text-[12px] text-white/80">{error}</p>
                {error.includes('API key') && (
                  <p className="text-[11px] text-white/70 mt-2">Add the provider's API key to <code className="text-[#e8b84a]/60">.env</code> and restart the dev server, or use BYOK in Vault Settings.</p>
                )}
              </div>
            </div>
          ) : output ? (
            <div className="max-w-2xl">
              <pre className="text-[13px] text-white/90 whitespace-pre-wrap font-[inherit] leading-relaxed">
                {output}
                {generating && <span className="inline-block w-0.5 h-4 bg-[#e8b84a] ml-0.5 animate-pulse" />}
              </pre>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-[13px] text-white/60 mb-2">Output will appear here</p>
                <p className="text-[10px] text-white/50">
                  {mode === 'auto'
                    ? 'Just type your instruction — relevant files will be found automatically'
                    : 'Select files, write an instruction, hit Generate'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
