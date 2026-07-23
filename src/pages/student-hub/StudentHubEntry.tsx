import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { listSessions } from '@/lib/student-hub';
import { T } from '@/components/student-hub/theme';
import StudentHubHome from './StudentHubHome';

// The front door of the Student Hub is the casebook itself: entering the
// hub seats you at your most recent reading — the case-caption page. The
// shelf (the table of readings and the intake desk) is the supplemental
// surface at /app/student-hub/readings.

export default function StudentHubEntry() {
  // null = still looking; '' = no readings yet, show the shelf.
  const [dest, setDest] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    listSessions()
      .then((ss) => setDest(ss.length ? ss[0].id : ''))
      .catch(() => setFailed(true));
  }, []);

  if (failed || dest === '') return <StudentHubHome />;
  if (dest) return <Navigate to={`/app/student-hub/${dest}`} replace />;
  return (
    <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%', padding: '40px 20px' }}>
      <p style={{ fontFamily: T.mono, fontSize: 12, color: T.faint }}>Opening your casebook…</p>
    </div>
  );
}
