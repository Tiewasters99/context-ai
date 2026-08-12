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

/** Panel B — the second venire (keyed to public/courtroom/venire2-N.png). */
export const VENIRE2_BIOS: Record<number, VenireBio> = {
  1: {
    name: 'Gus Palowski',
    tagline: 'Master plumber, 51',
    bio: 'Thirty years of fixing what the last guy botched. Came in off a job, washed up, and still has the pencils in his bib. Was stiffed by a general contractor once — filed the lien, got paid, never forgot it.',
  },
  2: {
    name: 'Dorothy Bell',
    tagline: 'Retired fourth-grade teacher, 67',
    bio: 'Thirty-one Septembers in the same classroom. Has heard every excuse a human being can invent and graded it. Kind eyes, immovable standards; keeps her word and expects yours.',
  },
  3: {
    name: 'Frank DiSalvo',
    tagline: 'Retired insurance adjuster, 73',
    bio: 'Spent four decades pricing other people\'s disasters and finding the padding in the claim. Arms crossed before the first witness. The hardest sell in either panel — and the most valuable when he moves.',
  },
  4: {
    name: 'Amara Wells',
    tagline: 'Marketing manager, 33',
    bio: 'Runs campaigns for a consumer brand; reads a room in a glance and a deck in a minute. Impatient with padding, allergic to jargon. Decides fast and holds it loosely until the numbers land.',
  },
  5: {
    name: 'Esteban Ruiz',
    tagline: 'Landscaping crew owner, 46',
    bio: 'Built a four-truck operation from one mower. The tattoos are old; the patience is new. Judges people by how they treat a crew in August. Quiet through the noise, decisive at the end.',
  },
  6: {
    name: 'Nora Sheehan',
    tagline: 'Bank branch manager, 44',
    bio: 'Approves loans all day, which means she says no all day and sleeps fine. Reads contracts before signing hotel wifi terms. Believes most disputes are two people who skipped the paperwork.',
  },
  7: {
    name: 'Danny Song',
    tagline: 'IT support specialist, 29',
    bio: 'Closes forty tickets a week and knows the difference between a system problem and a user problem. Precise, skeptical of confident people, comfortable saying "that\'s not what the log shows."',
  },
  8: {
    name: 'Walt Jessup',
    tagline: 'Retired charter-boat captain, 77',
    bio: 'Ran fishing charters out of the Gulf for forty years; the jacket has seen weather. Distrusts institutions, likes people, tells sea stories until the foreman clears his throat. Votes his gut and defends it.',
  },
  9: {
    name: 'Claire Fontaine',
    tagline: 'Hotel events manager, 38',
    bio: 'Handles four hundred weddings\' worth of other people\'s emergencies with a level voice. Notices who apologizes and who explains. Composure is her profession; she rates witnesses on theirs.',
  },
  10: {
    name: 'Ari Beaumont',
    tagline: 'Junior architect, 27',
    bio: 'Draws load-bearing walls for a living and thinks arguments have them too. Quietly relentless about foundations — if the premise doesn\'t hold, the flourish doesn\'t matter. Dresses better than the partners.',
  },
  11: {
    name: 'Peggy Ostrowski',
    tagline: 'Retired school-cafeteria manager, 78',
    bio: 'Fed twelve hundred children a day on a budget that never once balanced itself. Folded hands, sensible boots, no hurry left in her. Waits everyone out, then says the thing the room was avoiding.',
  },
  12: {
    name: 'Maya Castellano',
    tagline: 'Nursing student, 25',
    bio: 'Second-year nursing student who works intake shifts at a clinic. Has watched people at their worst and stayed kind about it. Takes the instructions seriously; expects everyone else to as well.',
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
