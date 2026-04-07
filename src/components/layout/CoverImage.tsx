import { useState, useRef } from 'react';
import { ImagePlus, X, Upload, Palette, Image } from 'lucide-react';

const templateCovers = [
  { id: 'gradient-indigo', name: 'Indigo Wave', type: 'gradient' as const, value: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a78bfa 100%)' },
  { id: 'gradient-ocean', name: 'Ocean', type: 'gradient' as const, value: 'linear-gradient(135deg, #0ea5e9 0%, #2563eb 50%, #1e40af 100%)' },
  { id: 'gradient-sunset', name: 'Sunset', type: 'gradient' as const, value: 'linear-gradient(135deg, #f97316 0%, #ef4444 50%, #dc2626 100%)' },
  { id: 'gradient-forest', name: 'Forest', type: 'gradient' as const, value: 'linear-gradient(135deg, #10b981 0%, #059669 50%, #047857 100%)' },
  { id: 'gradient-midnight', name: 'Midnight', type: 'gradient' as const, value: 'linear-gradient(135deg, #1e293b 0%, #334155 50%, #475569 100%)' },
  { id: 'gradient-rose', name: 'Rose Gold', type: 'gradient' as const, value: 'linear-gradient(135deg, #fb7185 0%, #e11d48 50%, #be123c 100%)' },
  { id: 'gradient-aurora', name: 'Aurora', type: 'gradient' as const, value: 'linear-gradient(135deg, #6366f1 0%, #06b6d4 50%, #10b981 100%)' },
  { id: 'gradient-amber', name: 'Amber', type: 'gradient' as const, value: 'linear-gradient(135deg, #f59e0b 0%, #d97706 50%, #b45309 100%)' },
];

interface CoverImageProps {
  coverUrl?: string;
  onCoverChange?: (url: string) => void;
  editable?: boolean;
}

export default function CoverImage({
  coverUrl,
  onCoverChange,
  editable = false,
}: CoverImageProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [currentCover, setCurrentCover] = useState(coverUrl ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCoverSelect = (value: string) => {
    setCurrentCover(value);
    onCoverChange?.(value);
    setShowPicker(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setCurrentCover(url);
    onCoverChange?.(url);
    setShowPicker(false);
  };

  const handleRemoveCover = () => {
    setCurrentCover('');
    onCoverChange?.('');
    setShowPicker(false);
  };

  const isGradient = currentCover.startsWith('linear-gradient');
  const hasImage = currentCover && !isGradient;
  const hasCover = !!currentCover;

  // No cover set — just show a small icon in the corner
  if (!hasCover) {
    return (
      <div className="relative w-full h-8">
        {editable && (
          <>
            <button
              onClick={() => setShowPicker(true)}
              className="absolute top-2 right-4 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-[#5a5665] hover:text-[#8a8693] hover:bg-[#1c1c26] transition-colors"
              title="Add cover"
            >
              <Image size={14} />
              <span>Add cover</span>
            </button>
            {showPicker && <CoverPicker onSelect={handleCoverSelect} onUpload={handleFileUpload} onRemove={handleRemoveCover} onClose={() => setShowPicker(false)} fileInputRef={fileInputRef} hasCover={false} />}
          </>
        )}
      </div>
    );
  }

  // Cover is set — show full banner
  return (
    <div className="relative w-full">
      <div
        className="relative w-full h-[180px] overflow-hidden"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {hasImage ? (
          <img
            src={currentCover}
            alt="Cover"
            className="w-full h-full object-cover transition-transform duration-300 ease-in-out"
            style={{ transform: isHovered && editable ? 'scale(1.02)' : 'scale(1)' }}
          />
        ) : (
          <div className="w-full h-full" style={{ background: currentCover }} />
        )}

        {/* Hover overlay with change button */}
        {editable && (
          <div
            className={`absolute inset-0 flex items-end justify-end p-3 transition-opacity duration-200 ${
              isHovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <div className="flex gap-2">
              <button
                onClick={handleRemoveCover}
                className="px-3 py-1.5 text-xs font-medium text-white bg-black/40 backdrop-blur-sm rounded-md hover:bg-black/50 transition-colors"
              >
                Hide cover
              </button>
              <button
                onClick={() => setShowPicker(true)}
                className="px-3 py-1.5 text-xs font-medium text-white bg-black/40 backdrop-blur-sm rounded-md hover:bg-black/50 transition-colors"
              >
                Change cover
              </button>
            </div>
          </div>
        )}
      </div>

      {showPicker && <CoverPicker onSelect={handleCoverSelect} onUpload={handleFileUpload} onRemove={handleRemoveCover} onClose={() => setShowPicker(false)} fileInputRef={fileInputRef} hasCover={true} />}
    </div>
  );
}

// Extracted picker so it can be used in both modes
function CoverPicker({
  onSelect,
  onUpload,
  onRemove,
  onClose,
  fileInputRef,
  hasCover,
}: {
  onSelect: (value: string) => void;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
  onClose: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  hasCover: boolean;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="absolute right-4 top-full z-50 w-full max-w-md bg-[#1c1c26] rounded-xl shadow-xl border border-[rgba(255,255,255,0.06)] p-5 mt-2">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[#f5f2ed]">Choose a cover</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#22222e] text-[#5a5665]">
            <X size={16} />
          </button>
        </div>

        {/* Upload */}
        <div className="mb-5">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 w-full p-3 rounded-lg border border-dashed border-[rgba(255,255,255,0.1)] text-sm text-[#8a8693] hover:border-[#d4a054] hover:text-[#d4a054] hover:bg-[#d4a054]/5 transition-colors"
          >
            <Upload size={16} />
            Upload your own image
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={onUpload} className="hidden" />
        </div>

        {/* Templates */}
        <div className="mb-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[#8a8693] mb-3">
            <Palette size={12} />
            Templates
          </div>
          <div className="grid grid-cols-4 gap-2">
            {templateCovers.map((template) => (
              <button
                key={template.id}
                onClick={() => onSelect(template.value)}
                className="group relative h-16 rounded-lg overflow-hidden border-2 border-transparent hover:border-[#d4a054] transition-colors"
                title={template.name}
              >
                <div className="w-full h-full" style={{ background: template.value }} />
                <div className="absolute inset-0 flex items-end opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="w-full text-center text-[10px] font-medium text-white bg-black/40 py-0.5">
                    {template.name}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Custom artwork */}
        <div className="mb-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[#8a8693] mb-3">
            <ImagePlus size={12} />
            Your Artwork
          </div>
          <p className="text-xs text-[#5a5665] italic">
            Drop image files into <code className="bg-[#22222e] px-1 rounded">public/covers/</code> and they'll appear here.
          </p>
        </div>

        {/* Remove */}
        {hasCover && (
          <button onClick={onRemove} className="w-full text-center text-xs text-red-400 hover:text-red-300 py-2">
            Remove cover
          </button>
        )}
      </div>
    </>
  );
}
