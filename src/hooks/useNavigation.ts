import { useState } from 'react';
import type { BreadcrumbItem } from '@/lib/types';

export function useNavigation() {
  const [history, setHistory] = useState<BreadcrumbItem[]>([]);

  const push = (item: BreadcrumbItem) => {
    setHistory((prev) => [...prev, item]);
  };

  const pop = () => {
    setHistory((prev) => prev.slice(0, -1));
  };

  const current = history.length > 0 ? history[history.length - 1] : null;

  const breadcrumbs = history;

  return { push, pop, current, breadcrumbs };
}
