import { useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Bell } from 'lucide-react';
import Sidebar from './Sidebar';
import Assistant from '@/components/ai/Assistant';

export default function MainLayout() {
  const navigate = useNavigate();
  const [assistantOpen, setAssistantOpen] = useState(false);

  return (
    <div className="flex h-screen bg-white">
      <Sidebar onToggleAssistant={() => setAssistantOpen(!assistantOpen)} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="flex items-center justify-between h-14 px-4 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(-1)}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
              aria-label="Go back"
            >
              <ArrowLeft size={18} />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button className="p-2 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
              <Search size={18} />
            </button>
            <button className="p-2 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors relative">
              <Bell size={18} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-indigo-500 rounded-full" />
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <Assistant isOpen={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}
