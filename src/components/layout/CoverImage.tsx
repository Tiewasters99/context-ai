import { useState } from 'react';

interface CoverImageProps {
  coverUrl?: string;
  onChangeCover?: () => void;
  editable?: boolean;
}

export default function CoverImage({
  coverUrl,
  onChangeCover,
  editable = false,
}: CoverImageProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className="relative w-full h-[200px] overflow-hidden rounded-b-xl"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {coverUrl ? (
        <img
          src={coverUrl}
          alt="Cover"
          className="w-full h-full object-cover transition-transform duration-300 ease-in-out"
          style={{ transform: isHovered && editable ? 'scale(1.02)' : 'scale(1)' }}
        />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-slate-100 via-slate-50 to-slate-200" />
      )}

      {/* Change Cover Overlay */}
      {editable && (
        <div
          className={`absolute inset-0 flex items-center justify-center bg-black/30 transition-opacity duration-200 ease-in-out ${
            isHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <button
            onClick={onChangeCover}
            className="px-4 py-2 text-sm font-medium text-white bg-white/20 backdrop-blur-sm border border-white/30 rounded-lg hover:bg-white/30 transition-colors cursor-pointer"
          >
            Change Cover
          </button>
        </div>
      )}
    </div>
  );
}
