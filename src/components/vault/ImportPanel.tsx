import { useState, useRef } from 'react';
import { Upload, Cloud, HardDrive, FileText, X, Check, Loader2 } from 'lucide-react';

interface ImportedFile {
  id: string;
  name: string;
  size: string;
  type: string;
  status: 'uploading' | 'ready' | 'indexing' | 'indexed';
}

// Mock imported files for Labib demo
const mockFiles: ImportedFile[] = [
  { id: 'f1', name: 'Smith_v_Jones_Opinion.pdf', size: '2.4 MB', type: 'pdf', status: 'indexed' },
  { id: 'f2', name: 'Labib_Letterhead.docx', size: '156 KB', type: 'docx', status: 'indexed' },
  { id: 'f3', name: 'Case_Alpha_Discovery.pdf', size: '18.7 MB', type: 'pdf', status: 'indexed' },
  { id: 'f4', name: 'Opposing_Counsel_Correspondence.pdf', size: '4.1 MB', type: 'pdf', status: 'indexed' },
  { id: 'f5', name: 'Settlement_Demand_Template.docx', size: '89 KB', type: 'docx', status: 'indexed' },
  { id: 'f6', name: 'Expert_Report_Williams.pdf', size: '12.3 MB', type: 'pdf', status: 'indexed' },
];

const connectors = [
  { name: 'OneDrive', icon: Cloud, connected: false },
  { name: 'Google Drive', icon: Cloud, connected: false },
  { name: 'Dropbox', icon: Cloud, connected: false },
  { name: 'Local Files', icon: HardDrive, connected: true },
];

export default function ImportPanel() {
  const [files, setFiles] = useState<ImportedFile[]>(mockFiles);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles) return;

    const newFiles: ImportedFile[] = Array.from(uploadedFiles).map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      size: f.size > 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${(f.size / 1024).toFixed(0)} KB`,
      type: f.name.split('.').pop() ?? 'file',
      status: 'uploading' as const,
    }));

    setFiles((prev) => [...newFiles, ...prev]);

    // Simulate upload + indexing
    newFiles.forEach((nf) => {
      setTimeout(() => setFiles((prev) => prev.map((f) => f.id === nf.id ? { ...f, status: 'indexing' } : f)), 1000);
      setTimeout(() => setFiles((prev) => prev.map((f) => f.id === nf.id ? { ...f, status: 'indexed' } : f)), 2500);
    });
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const statusIcon = (status: ImportedFile['status']) => {
    switch (status) {
      case 'uploading': return <Loader2 size={14} className="animate-spin text-white/50" />;
      case 'indexing': return <Loader2 size={14} className="animate-spin text-[#e8b84a]" />;
      case 'indexed': return <Check size={14} className="text-emerald-400" />;
      default: return <Check size={14} className="text-emerald-400" />;
    }
  };

  const statusLabel = (status: ImportedFile['status']) => {
    switch (status) {
      case 'uploading': return 'Uploading...';
      case 'indexing': return 'Indexing for AI...';
      case 'indexed': return 'Ready';
      default: return 'Ready';
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="px-6 py-5 border-b border-[rgba(255,255,255,0.08)]">
        <h2 className="text-[18px] font-semibold text-white mb-1">Import Documents</h2>
        <p className="text-[13px] text-white/60">Add files to your Vault for AI-powered analysis and generation.</p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Upload area */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full p-8 rounded-lg border-2 border-dashed border-[rgba(255,255,255,0.1)] hover:border-[#e8b84a]/50 transition-all group flex flex-col items-center gap-3"
        >
          <Upload size={24} className="text-white/30 group-hover:text-[#e8b84a] transition-colors" />
          <span className="text-[14px] text-white/50 group-hover:text-white transition-colors">Drop files here or click to upload</span>
          <span className="text-[11px] text-white/25">PDF, DOCX, XLSX, PPTX, TXT, images — up to 100GB total</span>
        </button>
        <input ref={fileInputRef} type="file" multiple onChange={handleUpload} className="hidden" />

        {/* Cloud connectors */}
        <div className="mt-6">
          <h3 className="text-[11px] font-semibold text-white/40 uppercase tracking-wider mb-3">Connect Cloud Storage</h3>
          <div className="grid grid-cols-2 gap-2">
            {connectors.map((c) => (
              <button
                key={c.name}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,255,255,0.12)] transition-colors"
              >
                <c.icon size={16} className="text-white/40" strokeWidth={1.75} />
                <span className="text-[12px] text-white/70">{c.name}</span>
                {c.connected && <span className="text-[10px] text-emerald-400 ml-auto">Connected</span>}
                {!c.connected && <span className="text-[10px] text-white/20 ml-auto">Connect</span>}
              </button>
            ))}
          </div>
        </div>

        {/* File list */}
        <div className="mt-6">
          <h3 className="text-[11px] font-semibold text-white/40 uppercase tracking-wider mb-3">
            Vault Files ({files.length})
          </h3>
          <div className="space-y-1">
            {files.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[rgba(255,255,255,0.03)] transition-colors group"
              >
                <FileText size={16} className="text-white/30 shrink-0" strokeWidth={1.75} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-white truncate">{file.name}</p>
                  <p className="text-[10px] text-white/30">{file.size} · {file.type.toUpperCase()}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-white/40">{statusLabel(file.status)}</span>
                  {statusIcon(file.status)}
                </div>
                <button
                  onClick={() => removeFile(file.id)}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[rgba(255,255,255,0.06)] text-white/30 hover:text-white transition-all"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
