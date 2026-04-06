import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { BreadcrumbItem } from '@/lib/types';

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export default function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <span key={item.id} className="flex items-center gap-1.5">
            {index > 0 && (
              <ChevronRight size={14} className="text-slate-300 shrink-0" />
            )}
            {isLast ? (
              <span className="text-slate-800 font-medium">{item.label}</span>
            ) : (
              <Link
                to={item.path}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
