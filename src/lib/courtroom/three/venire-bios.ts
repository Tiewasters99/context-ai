// The Courtroom — identities for the house venire and the bench (Phase 3).
//
// DISPLAY LAYER ONLY. These blurbs caption the portrait figures seated in
// the 3D room — drawn from the images and their generation prompts, in the
// voice of counsel's seating-chart notes from voir dire. They are texture
// for the room, NOT data: nothing here ever enters a juror prompt, a
// sampler, or a report (the §2.3 rail). The reasoning layer's jurors —
// names, occupations, attitudes — live on the sampled panel and appear on
// the panel sheet, not here.
//
// Provenance: figures drawn partly from Eden's memory of the Coleman voir
// dire. Judge Reilly's bio as dictated by Eden, 2026-08-09.

export interface VenireBio {
  name: string;
  tagline: string;
  bio: string;
}

/** Keyed by seat (matches public/courtroom/venire-N.png and SOURCES.md). */
export const VENIRE_BIOS: Record<number, VenireBio> = {
  1: {
    name: 'Marcus Boone',
    tagline: 'Master electrician, 44',
    bio: 'Twenty-two years running conduit on commercial jobs, the last nine as a foreman. Came to court straight from a site — kept the cap on, tools still in the chest pocket. Answers exactly the question asked, nothing more.',
  },
  2: {
    name: 'Vivian Cho',
    tagline: 'Gallery director, 36',
    bio: 'Directs a downtown gallery; before that, seven years at an auction house. Sat perfectly composed through three hours of voir dire. Notices what people wear and what they avoid saying.',
  },
  3: {
    name: 'Saul Berkowitz',
    tagline: 'Retired accountant, 71',
    bio: 'Forty-one tax seasons, the last twenty with his own small practice. Reads every document he is handed, all the way through, including the footnotes. Distrusts round numbers on principle.',
  },
  4: {
    name: 'Marisol Vega',
    tagline: 'Homemaker, 52',
    bio: 'Raised four children; treasurer of her parish council. Runs a household budget to the dollar. Said during voir dire that she decides about people by how they treat the ones who work for them.',
  },
  5: {
    name: 'Terrence Cole',
    tagline: 'Wealth-management vice president, 47',
    bio: 'Twenty years in private banking; dresses like the meeting matters. Sits on two nonprofit boards. Familiar with contracts, familiar with being pitched, and visibly hard to pitch.',
  },
  6: {
    name: 'Bonnie Whitaker',
    tagline: 'Homemaker, 33',
    bio: 'Moved out from the city six years ago; garden club, school pickup line, a part-time bookkeeping job she rarely mentions. Friendly in the hallway, watchful in the box.',
  },
  7: {
    name: 'Emma Doyle',
    tagline: 'Graduate student, 24',
    bio: 'Second-year sociology master\'s student who waits tables on weekends. Took notes during jury instructions until told to stop. First juror to make eye contact with whoever is speaking.',
  },
  8: {
    name: 'Rajan Mehta',
    tagline: 'Tailor-shop owner, 53',
    bio: 'Owns the alterations shop his uncle started; works six days a week at the same bench. Measures twice on everything. Asked the only clarifying question of the entire venire.',
  },
  9: {
    name: 'Carmen Ortiz',
    tagline: 'Salon owner, 41',
    bio: 'Built her salon from one chair to six. Hears everyone\'s troubles all day and has learned exactly when someone is performing. Warm until she isn\'t.',
  },
  10: {
    name: 'Kyle Brandt',
    tagline: 'Pharmaceutical sales representative, 26',
    bio: 'Two years out of college, where he captained the lacrosse team; back straight, firm handshake, early to everything. Comfortable being evaluated and assumes he is.',
  },
  11: {
    name: 'Yvonne Pierce',
    tagline: 'Hospital administrator, 49',
    bio: 'Runs scheduling and compliance for a regional hospital system. Spends her working life between doctors, insurers, and grieving families, and no longer startles. Elegant, still, and completely unhurried.',
  },
  12: {
    name: 'Theo Marsh',
    tagline: 'Barista and part-time student, 23',
    bio: 'Pulls espresso mornings, takes night classes in film. Borrowed the suit. Slouches like he isn\'t listening; the recall questions during voir dire said otherwise.',
  },
};

export interface JudgeBio {
  name: string;
  tagline: string;
  paragraphs: string[];
}

/** As dictated by Eden, 2026-08-09. */
export const JUDGE_BIO: JudgeBio = {
  name: 'Hon. Mary Reilly',
  tagline: 'United States District Judge',
  paragraphs: [
    'B.A., Yale; J.D., Harvard. Fifteen years in private practice before taking the bench. Carries a reputation as a pro-defendant judge.',
    'Significant decisions: Patel v. Unisource — found for the company on theft of trade secrets after a bench trial. Tarp v. Richville University — summary judgment for the University; no triable issue of fact on causation.',
  ],
};
