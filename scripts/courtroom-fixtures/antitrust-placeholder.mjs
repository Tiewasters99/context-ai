// Golden scenario 3 — LABIB_STERIS_PLACEHOLDER (complex antitrust).
//
// TODO(Eden): this slot belongs to the anonymized Labib/Steris facts (spec
// §12.6). Eden supplies (or approves generation of) the anonymized record;
// until then the eval runs on the AUTHORED GENERIC antitrust facts below —
// exclusive dealing + tying in a regional medical-sterilization market — and
// the eval is not considered "real" for the antitrust scenario (spec §12.6).
//
// Script: a fractured panel that keeps inching without converging.
// Exercises the 'max_rounds' stop condition (5 rounds).

export default {
  name: 'Antitrust — LABIB_STERIS_PLACEHOLDER (MedHold v. ApexSteril, generic facts)',
  seed: 20260809,
  panelSize: 12,
  trialTitle: 'MedHold Diagnostics v. ApexSteril — exclusive dealing and tying (PLACEHOLDER FACTS)',
  segments: [
    {
      id: 'at-seg-1', kind: 'opening', side: 'ours', position: 0,
      transcript: [
        'Every surgical instrument in every hospital in this region has to be sterilized, and for nine years one company has decided who gets to do that work. ApexSteril controls eighty-two percent of contracted sterilization capacity across the tri-county hospital systems.',
        'The evidence will show three things. First, ApexSteril\'s standard hospital contract requires exclusivity — a hospital that sends even one instrument tray to a rival loses its priority scheduling and its volume rebate, which for a mid-size hospital is worth over a million dollars a year. Second, ApexSteril ties its sterilization service to its monitoring software: refuse the software, pay a forty percent surcharge. Third, when MedHold opened a certified facility eleven miles from Mercy General, ApexSteril\'s regional director wrote in an email you will see: quote, make the rebate math impossible for them.',
        'MedHold does not ask you to punish success. It asks you to look at contracts built not to win business, but to make competing for it irrational.',
      ].join('\n\n'),
    },
    {
      id: 'at-seg-2', kind: 'cross', side: 'theirs', position: 1,
      transcript: [
        'Doctor Reyes, you are MedHold\'s economics expert. Your market definition excludes in-house hospital sterilization entirely — the sterilizers hospitals run in their own basements. If those are counted, ApexSteril\'s share drops to forty-one percent, doesn\'t it?',
        'And the rebate you call exclusionary: not one hospital testified it wanted to switch and could not. Mercy General\'s own procurement chief signed a renewal three months after MedHold opened — and negotiated the rebate up, not down. That is bargaining, not coercion.',
        'You calculated damages assuming MedHold would have captured thirty percent of the market in four years. MedHold has never captured thirty percent of any market it has entered. You assumed it here because the number needed to be large. Correct?',
      ].join('\n\n'),
    },
    {
      id: 'at-seg-3', kind: 'closing', side: 'ours', position: 2,
      transcript: [
        'They say count the basements. But a hospital cannot sell its basement sterilizer\'s spare hour to the hospital across town — in-house capacity is not in the market, and their own witness conceded no hospital has built new in-house capacity in a decade.',
        'And the email is still the email: make the rebate math impossible for them. Businesses compete on price and quality. Monopolists compete on arithmetic no rival is allowed to survive. You have the contracts. Do the arithmetic yourselves.',
      ].join('\n\n'),
    },
  ],
  ballots: {
    1: { 0: ['ours', 5], 1: ['ours', 4], 2: ['ours', 5], 3: ['ours', 4], 4: ['ours', 5], 5: ['ours', 4] },
    2: { 0: ['ours', 4] },
    3: { 0: ['ours', 5] },
    4: { 0: ['ours', 4] },
    5: { 0: ['ours', 6] },
    6: { 0: ['ours', 3] },
    7: { 0: ['theirs', 5] },
    8: { 0: ['theirs', 6] },
    9: { 0: ['theirs', 4] },
    10: { 0: ['theirs', 5] },
    11: { 0: ['theirs', 4], 3: ['theirs', 5] },
    12: { 0: ['undecided', 2], 2: ['theirs', 3] },
  },
  // Seat 1 oscillates every round; seat 12 breaks undecided in round 2; seat
  // 11 hardens in round 3 — movement every round, never unanimous, so the
  // panel runs the full 5 rounds.
  expect: { stop: 'max_rounds', rounds: 5, movement: 9 },
};
