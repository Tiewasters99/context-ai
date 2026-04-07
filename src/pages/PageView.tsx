import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Lock, Unlock, Tag } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';

export default function PageView() {
  const { id } = useParams();
  const [title, setTitle] = useState(id === 'new' ? '' : 'Project Roadmap');
  const [isLocked, setIsLocked] = useState(false);

  const tags = [
    { id: 't1', name: 'Planning', color: 'bg-blue-500/15 text-blue-400' },
    { id: 't2', name: 'Q2', color: 'bg-emerald-500/15 text-emerald-400' },
  ];

  return (
    <div>
      <CoverImage editable />

      <div className="max-w-4xl mx-auto px-8 py-8">
        <div className="flex gap-8">
          {/* Main content */}
          <div className="flex-1 min-w-0">
            {/* Title */}
            <div
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => setTitle(e.currentTarget.textContent ?? '')}
              className="text-3xl font-bold text-[#f5f2ed] outline-none mb-1 empty:before:content-['Untitled'] empty:before:text-[#5a5665]"
              data-placeholder="Untitled"
            >
              {title}
            </div>

            {/* Editor placeholder */}
            <div
              contentEditable
              suppressContentEditableWarning
              className="mt-6 min-h-[400px] text-[#e8e4de] leading-relaxed outline-none text-[15px] empty:before:content-['Start_writing,_or_press_/_for_commands...'] empty:before:text-[#5a5665]"
            >
            </div>
          </div>

          {/* Side panel */}
          <div className="w-56 shrink-0">
            <div className="sticky top-8 space-y-6">
              {/* Lock toggle */}
              <div>
                <button
                  onClick={() => setIsLocked(!isLocked)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full ${
                    isLocked
                      ? 'bg-[#d4a054]/10 text-[#d4a054] hover:bg-[#d4a054]/15'
                      : 'bg-[#1c1c26] text-[#8a8693] hover:bg-[#22222e]'
                  }`}
                >
                  {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
                  {isLocked ? 'Locked' : 'Unlocked'}
                </button>
              </div>

              {/* Tags */}
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-[#8a8693] mb-2">
                  <Tag size={12} />
                  Tags
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <span
                      key={tag.id}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${tag.color}`}
                    >
                      {tag.name}
                    </span>
                  ))}
                  <button className="px-2 py-0.5 rounded-full text-xs text-[#5a5665] border border-dashed border-[rgba(255,255,255,0.1)] hover:border-[rgba(255,255,255,0.2)] hover:text-[#8a8693] transition-colors">
                    + Add
                  </button>
                </div>
              </div>

              {/* Metadata */}
              <div className="space-y-2 text-xs text-[#8a8693]">
                <div className="flex justify-between">
                  <span>Created</span>
                  <span className="text-[#e8e4de]">Apr 1, 2026</span>
                </div>
                <div className="flex justify-between">
                  <span>Modified</span>
                  <span className="text-[#e8e4de]">Apr 4, 2026</span>
                </div>
                <div className="flex justify-between">
                  <span>Status</span>
                  <span className={isLocked ? 'text-[#d4a054]' : 'text-[#4ade80]'}>
                    {isLocked ? 'Locked' : 'Editable'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
