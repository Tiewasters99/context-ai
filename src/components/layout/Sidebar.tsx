import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Home,
  Plus,
  ChevronRight,
  ChevronDown,
  Settings,
  LogOut,
  Bot,
  PanelLeft,
  Users,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

interface MockMatterspace {
  id: string;
  name: string;
}

interface MockServerspace {
  id: string;
  name: string;
  matterspaces: MockMatterspace[];
}

interface SidebarProps {
  onToggleAssistant?: () => void;
}

export default function Sidebar({ onToggleAssistant }: SidebarProps) {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [aiAssistantEnabled, setAiAssistantEnabled] = useState(false);

  const [serverspaces] = useState<MockServerspace[]>([
    {
      id: '1',
      name: 'Marketing Team',
      matterspaces: [
        { id: 'm1', name: 'Q2 Campaign' },
        { id: 'm2', name: 'Brand Assets' },
      ],
    },
    {
      id: '2',
      name: 'Product Dev',
      matterspaces: [
        { id: 'm3', name: 'Sprint Planning' },
        { id: 'm4', name: 'Bug Triage' },
      ],
    },
  ]);

  const displayName = user?.user_metadata?.display_name ?? user?.email ?? 'User';

  const toggleExpanded = (id: string) => {
    setExpandedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const isActive = (path: string) => location.pathname === path;

  const sidebarWidth = collapsed ? 'w-16' : 'w-64';

  return (
    <aside
      className={`${sidebarWidth} h-screen flex flex-col shrink-0 transition-all duration-200 ease-in-out`}
      style={{ backgroundColor: '#f1f5f9' }}
    >
      {/* Brand + Collapse Toggle */}
      <div className="flex items-center justify-between px-4 h-14 border-b border-slate-200">
        {!collapsed && (
          <span className="text-base font-semibold text-slate-800 tracking-tight">
            Context.ai
          </span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-md hover:bg-slate-200/70 text-slate-500 transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <PanelLeft size={18} />
        </button>
      </div>

      {/* User Section */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200">
        <div className="w-8 h-8 rounded-full bg-slate-300 flex items-center justify-center text-sm font-medium text-slate-600 shrink-0">
          {displayName[0]?.toUpperCase() ?? 'U'}
        </div>
        {!collapsed && (
          <div className="flex items-center justify-between flex-1 min-w-0">
            <span className="text-sm font-medium text-slate-700 truncate">
              {displayName}
            </span>
            <Link
              to="/app/settings"
              className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 transition-colors"
            >
              <Settings size={15} />
            </Link>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {/* My Clientspace */}
        <Link
          to="/app"
          className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
            isActive('/app')
              ? 'bg-slate-200/80 text-slate-900 font-medium'
              : 'text-slate-600 hover:bg-slate-200/50'
          }`}
        >
          <Home size={18} className="shrink-0" />
          {!collapsed && <span>My Clientspace</span>}
        </Link>

        {/* Serverspaces Header */}
        <div className="flex items-center justify-between mt-5 mb-1 px-3">
          {!collapsed && (
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Serverspaces
            </span>
          )}
          <button
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 transition-colors"
            aria-label="Create new serverspace"
          >
            <Plus size={15} />
          </button>
        </div>

        {/* Serverspace List */}
        <div className="space-y-0.5">
          {serverspaces.map((space) => {
            const isExpanded = expandedSpaces.has(space.id);
            return (
              <div key={space.id}>
                <button
                  onClick={() => toggleExpanded(space.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                    isActive(`/app/server/${space.id}`)
                      ? 'bg-slate-200/80 text-slate-900 font-medium'
                      : 'text-slate-600 hover:bg-slate-200/50'
                  }`}
                >
                  <Users size={18} className="shrink-0" />
                  {!collapsed && (
                    <>
                      <span className="flex-1 truncate">{space.name}</span>
                      {isExpanded ? (
                        <ChevronDown size={14} className="text-slate-400 shrink-0" />
                      ) : (
                        <ChevronRight size={14} className="text-slate-400 shrink-0" />
                      )}
                    </>
                  )}
                </button>

                {/* Matterspaces */}
                {isExpanded && !collapsed && (
                  <div className="ml-5 pl-4 border-l border-slate-200 mt-0.5 space-y-0.5">
                    {space.matterspaces.map((ms) => (
                      <Link
                        key={ms.id}
                        to={`/app/server/${space.id}/matter/${ms.id}`}
                        className={`block px-3 py-1.5 rounded-md text-sm transition-colors ${
                          isActive(`/app/server/${space.id}/matter/${ms.id}`)
                            ? 'bg-slate-200/80 text-slate-900 font-medium'
                            : 'text-slate-500 hover:bg-slate-200/50 hover:text-slate-700'
                        }`}
                      >
                        {ms.name}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {/* Bottom Actions */}
      <div className="border-t border-slate-200 p-2 space-y-0.5">
        <button
          onClick={() => { setAiAssistantEnabled(!aiAssistantEnabled); onToggleAssistant?.(); }}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
            aiAssistantEnabled
              ? 'bg-indigo-50 text-indigo-700'
              : 'text-slate-600 hover:bg-slate-200/50'
          }`}
        >
          <Bot size={18} className="shrink-0" />
          {!collapsed && <span>AI Assistant</span>}
        </button>

        <Link
          to="/app/settings"
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-200/50 transition-colors"
        >
          <Settings size={18} className="shrink-0" />
          {!collapsed && <span>Settings</span>}
        </Link>

        <button
          onClick={() => signOut()}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-200/50 transition-colors"
        >
          <LogOut size={18} className="shrink-0" />
          {!collapsed && <span>Sign Out</span>}
        </button>
      </div>
    </aside>
  );
}
