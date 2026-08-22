// The matter Calendar tab.
//
// This used to be its own chronological list over matter_events. It is
// now a thin scope wrapper around the one Contextspaces calendar, so a
// matter's calendar looks and behaves exactly like the calendar anywhere
// else — month, week and agenda views, entries you can add, edit and
// delete, list due dates from this matter's lists, and Google import.
//
// Scoping to `matterId` means: only this matter's deadlines
// (matter_events), only calendar entries filed against this matter, and
// only due dates from lists that live in it. New entries default to this
// matter, so the picker is hidden.

import ContextspacesCalendar from '@/components/calendar/ContextspacesCalendar';

export default function MatterCalendar({ matterId }: { matterId: string }) {
  return <ContextspacesCalendar matterId={matterId} defaultMatterId={matterId} />;
}
