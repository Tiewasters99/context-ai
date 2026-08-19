// The rooms of the walkable office, themed by practice function — a filing
// system, not a stage set. One room per function; rooms without a job get
// whittled. Slugs are stable identity: the office front end maps its
// imagery onto these, so re-shooting a room never orphans its sections.
// office_sections.room holds one of these slugs, or '' for unassigned
// (the section then shows in the general Library).

export interface OfficeRoom {
  slug: string;
  label: string;
}

export const OFFICE_ROOMS: OfficeRoom[] = [
  { slug: 'reception', label: 'Reception — the firm’s front door' },
  { slug: 'boardroom-a', label: 'Boardroom A — deals & arbitration' },
  { slug: 'boardroom-b', label: 'Boardroom B — the litigation war room' },
  { slug: 'breakout', label: 'The Breakout — mediation' },
  { slug: 'office-a', label: 'Office A — research & writing' },
  { slug: 'office-c', label: 'Office C — advisory' },
  { slug: 'office-d', label: 'Office D — technology & AI practice' },
  { slug: 'office-e', label: 'Office E — advisory' },
  { slug: 'salon', label: 'The Salon — the firm’s intellectual life' },
];
