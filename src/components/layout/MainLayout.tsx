import { useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Bell } from 'lucide-react';
import Sidebar from './Sidebar';
import Assistant from '@/components/ai/Assistant';

export default function MainLayout() {
  const navigate = useNavigate();
  const [assistantOpen, setAssistantOpen] = useState(false);

  return (
    <div className="flex h-screen">
      <Sidebar onToggleAssistant={() => setAssistantOpen(!assistantOpen)} />

      <div className="flex-1 flex flex-col min-w-0 bg-cover bg-center bg-fixed bg-no-repeat" style={{ backgroundImage: "var(--page-cover, url('/gpu-cluster-2.png'))" }}>
        {/* Top bar */}
        <header className="flex items-center justify-between h-13 px-4 border-b border-[rgba(255,255,255,0.08)] shrink-0 backdrop-blur-[30px]" style={{ backgroundColor: 'rgba(10, 10, 16, 0.65)' }}>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(-1)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/70 hover:text-white transition-colors"
              aria-label="Go back"
            >
              <ArrowLeft size={18} strokeWidth={2} />
              <span className="text-[13px] font-medium">Back</span>
            </button>
          </div>

          <div className="flex items-center gap-0.5">
            <button className="p-2 rounded-md hover:bg-[#22222e] text-white/60 hover:text-white transition-colors">
              <Search size={16} strokeWidth={1.75} />
            </button>
            <button className="p-2 rounded-md hover:bg-[#22222e] text-white/60 hover:text-white transition-colors relative">
              <Bell size={16} strokeWidth={1.75} />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-[#d4a054] rounded-full" />
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
