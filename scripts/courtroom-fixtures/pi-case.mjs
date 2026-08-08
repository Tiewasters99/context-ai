// Golden scenario 1 — personal injury (slip-and-fall against a grocery chain).
// Script: a genuinely split first ballot that converges to unanimity in two
// rounds of deliberation. Exercises the 'unanimous' stop condition.

export default {
  name: 'PI — Herrera v. FreshMart (slip and fall)',
  seed: 20260807,
  panelSize: 12,
  trialTitle: 'Herrera v. FreshMart — opening, cross, closing',
  segments: [
    {
      id: 'pi-seg-1', kind: 'opening', side: 'ours', position: 0,
      transcript: [
        'May it please the court. On the morning of March 4th, Elena Herrera walked into the FreshMart on Corydon Avenue to buy groceries for her mother. She left on a stretcher, with a shattered hip that three surgeries have not fixed.',
        'The evidence will show that a freezer case in aisle seven had been leaking for eleven days. Eleven days of mop buckets, eleven days of warning cones that employees moved out of the way to restock shelves, eleven days of work orders marked urgent that nobody answered.',
        'FreshMart\'s own safety manual says a reported leak gets fixed in twenty-four hours. Their own log shows they knew. This case is about a company that decided a slippery floor was cheaper to ignore than to repair.',
      ].join('\n\n'),
    },
    {
      id: 'pi-seg-2', kind: 'cross', side: 'theirs', position: 1,
      transcript: [
        'Ms. Herrera, you told the paramedics you were looking at your phone when you fell, didn\'t you? And the text message you were reading was sent forty seconds before the 911 call.',
        'You had shopped at this store more than a hundred times. You knew aisle seven. You walked past a yellow cone at the end of that aisle — a cone that appears in the security footage eight feet from where you fell.',
        'The footage shows you took no step around the wet sheen that three other customers stepped around in the same hour. Not because it was invisible. Because you were not looking.',
      ].join('\n\n'),
    },
    {
      id: 'pi-seg-3', kind: 'closing', side: 'ours', position: 2,
      transcript: [
        'They want to talk about forty seconds of a text message. Let\'s talk about eleven days of a leak they logged and ignored. A cone eight feet away is not a repair. A mop bucket is not a repair.',
        'Their own safety director admitted the work order was marked urgent and unassigned. When a company writes the safety rule, breaks the safety rule, and then blames the customer for believing the floor was safe — that is negligence, and it has a price.',
      ].join('\n\n'),
    },
  ],
  // Per-seat ballot script: { round: [leaning, conviction] } — the value at
  // the greatest round key ≤ the current round governs.
  ballots: {
    1: { 0: ['ours', 5] },
    2: { 0: ['ours', 6] },
    3: { 0: ['ours', 4] },
    4: { 0: ['ours', 5] },
    5: { 0: ['ours', 6] },
    6: { 0: ['ours', 4] },
    7: { 0: ['ours', 5] },
    8: { 0: ['ours', 6] },
    9: { 0: ['theirs', 4], 1: ['ours', 4] },
    10: { 0: ['theirs', 5], 1: ['theirs', 4], 2: ['ours', 4] },
    11: { 0: ['theirs', 3], 1: ['ours', 4] },
    12: { 0: ['undecided', 2], 1: ['ours', 3] },
  },
  expect: { stop: 'unanimous', rounds: 2, movement: 11 },
};
