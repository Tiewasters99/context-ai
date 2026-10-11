import { useEffect, useState } from 'react';
import { getLatestFailedJob, type Production } from '@/lib/discovery';

export default function ProductionFailure({ production }: { production: Production }) {
  const [failure, setFailure] = useState<{ id: string; reason: string | null } | null>(null);
  useEffect(() => {
    if (production.status !== 'error') return;
    let cancelled = false;
    getLatestFailedJob(production.id).then((job) => {
      if (!cancelled) setFailure({ id: production.id, reason: job?.error ?? null });
    }).catch(() => {
      if (!cancelled) setFailure({ id: production.id, reason: 'The failure details could not be loaded. Refresh to retry.' });
    });
    return () => { cancelled = true; };
  }, [production.id, production.status]);

  if (production.status !== 'error') return null;
  const reason = (failure?.id === production.id ? failure.reason : null)
    ?? production.status_reason ?? 'The production could not be processed.';
  return (
    <span className="block mt-2 text-[11.5px] text-red-300 break-words" role="status">
      <span className="block">{reason.startsWith('Malicious entry:')
        ? `The ZIP contains a file path that could not be safely unpacked: ${reason.slice('Malicious entry:'.length).trim()}`
        : reason}</span>
      <span className="block mt-1 text-white/55">Try the upload again, or upload the files individually.</span>
    </span>
  );
}
