import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Lock, Unlock, Tag } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';

export default function PageView() {
  const { id } = useParams();
  const [title, setTitle] = useState(id === 'new' ? '' : 'Project Roadmap');
  const [isLocked, setIsLocked] = useState(false);

  const tags = [
    { id: 't1', name: 'Planning', color: 'bg-blue-100 text-blue-700' },
    { id: 't2', name: 'Q2', color: 'bg-emerald-100 text-emerald-700' },
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
              className="text-3xl font-bold text-slate-900 outline-none mb-1 empty:before:content-['Untitled'] empty:before:text-slate-300"
              data-placeholder="Untitled"
            >
              {title}
            </div>

            {/* Editor placeholder */}
            <div
              contentEditable
              suppressContentEditableWarning
              className="mt-6 min-h-[400px] text-slate-700 leading-relaxed outline-none text-[15px] empty:before:content-['Start_writing,_or_press_/_for_commands...'] empty:before:text-slate-300"
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
                      ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                      : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
                  {isLocked ? 'Locked' : 'Unlocked'}
                </button>
              </div>

              {/* Tags */}
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 mb-2">
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
                  <button className="px-2 py-0.5 rounded-full text-xs text-slate-400 border border-dashed border-slate-300 hover:border-slate-400 hover:text-slate-500 transition-colors">
                    + Add
                  </button>
                </div>
              </div>

              {/* Metadata */}
              <div className="space-y-2 text-xs text-slate-500">
                <div className="flex justify-between">
                  <span>Created</span>
                  <span className="text-slate-700">Apr 1, 2026</span>
                </div>
                <div className="flex justify-between">
                  <span>Modified</span>
                  <span className="text-slate-700">Apr 4, 2026</span>
                </div>
                <div className="flex justify-between">
                  <span>Status</span>
                  <span className={isLocked ? 'text-amber-600' : 'text-emerald-600'}>
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
