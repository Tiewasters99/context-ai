// Golden scenario 2 — contract dispute (breached supply agreement).
// Script: a split panel that moves a little in round 1 and then stops moving
// entirely. Exercises the 'hung' stop condition (two rounds without movement).

export default {
  name: 'Contract — Calloway Mills v. Brant Logistics (breach)',
  seed: 20260808,
  panelSize: 12,
  trialTitle: 'Calloway Mills v. Brant Logistics — breach of the 2024 supply agreement',
  segments: [
    {
      id: 'k-seg-1', kind: 'opening', side: 'ours', position: 0,
      transcript: [
        'This is a case about a signature. In January 2024, Brant Logistics signed a two-year agreement to carry every pallet Calloway Mills shipped east of the Mississippi, at a locked rate, with ninety days\' notice required before any change.',
        'In August, diesel got expensive. And Brant sent a one-paragraph email: new rates effective in ten days, take it or leave it. No ninety days. No negotiation. The contract clause they drafted themselves — section 11.2 — required written notice by certified mail. They sent an email on a Friday afternoon.',
        'Calloway scrambled for carriers at spot prices during harvest season and lost its two largest customers to missed deliveries. The damages are not hypothetical. They are invoices.',
      ].join('\n\n'),
    },
    {
      id: 'k-seg-2', kind: 'direct', side: 'theirs', position: 1,
      transcript: [
        'Mr. Brant, tell the jury about the force majeure clause. Section 14 covers, quote, extraordinary increases in operating costs beyond the carrier\'s reasonable control. Diesel rose forty-one percent in five months — the steepest climb in the corridor\'s recorded history.',
        'And you testified that you called Calloway\'s dispatch desk twice before the email. Both calls went to a voicemail box that was full. The email was a follow-up, not an ambush.',
        'You kept carrying their freight for six more weeks at the old rate while they, quote, evaluated. They never invoked the cure provision. They went shopping for carriers instead, and then they went shopping for a lawsuit.',
      ].join('\n\n'),
    },
    {
      id: 'k-seg-3', kind: 'closing', side: 'ours', position: 2,
      transcript: [
        'Section 14 says beyond the carrier\'s reasonable control — and their own CFO admitted on cross that they declined to buy the fuel hedge their board recommended in 2023. A risk you chose is not a force majeure. It is a bet that went bad.',
        'The certified-mail clause was theirs. The ninety days was theirs. Hold them to the words they wrote.',
      ].join('\n\n'),
    },
  ],
  ballots: {
    1: { 0: ['ours', 5] },
    2: { 0: ['ours', 5] },
    3: { 0: ['ours', 6] },
    4: { 0: ['ours', 4], 1: ['ours', 3] },
    5: { 0: ['ours', 5] },
    6: { 0: ['ours', 6] },
    7: { 0: ['ours', 5] },
    8: { 0: ['theirs', 5] },
    9: { 0: ['theirs', 4] },
    10: { 0: ['theirs', 6] },
    11: { 0: ['theirs', 5] },
    12: { 0: ['theirs', 4] },
  },
  // Round 1 moves one conviction point (seat 4) with no leaning change —
  // within the flat threshold, so it counts as a flat round; round 2 is frozen.
  // Two consecutive flat rounds hang the panel.
  expect: { stop: 'hung', rounds: 2, movement: 1 },
};
