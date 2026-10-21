// lib/trademark/application.mjs — stage 9, the application draft (spec §8
// slice 2; build brief 2026-10-21 §C). Deterministic: no model, no network.
//
//   normalizeApplication  the stored answers (tm_clearances.application), cleaned
//   mergeAnswers          a person's answers (browser form, or relayed by a bot
//                         through tm_application_answer) folded into them
//   applicationQuestions  what is still needed, per mark and class, in order
//   specimenCheck         the use-based specimen check — ADVISORY; the reviewer decides
//   recommendBasis        1(a) or 1(b) per class, with the reason
//   entityCautions        the applicant must exist on the filing date; domicile;
//                         an intent-to-use application's assignment bar
//   feeEstimate           the fee table (filing/rules.json, verified on a date)
//   assembleApplication   the DRAFT, in TEAS order, and the separate cautions annex
//
// Every statement of law printed here comes from filing/rules.json, which
// carries its source and the date it was verified ([V date, source]); an
// unverified one is printed with [M]. Nothing in this file is a citation
// written from memory.
//
// The product never says a mark is clear or registrable (lint.mjs); both
// documents are linted before they are shown or filed. A bot can relay the
// person's answers and read the DRAFT; it cannot sign it — stage 9 is signed
// off in the browser (migration 122 refuses a connector's sign-off).

import RULES from './filing/rules.json' with { type: 'json' };
import { forbiddenPhrases } from './lint.mjs';
import { cell } from './report.mjs';

export { RULES };

/** Goods are Nice classes 1–34; services 35–45. */
export const isServiceClass = (code) => Number(code) >= 35;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRI = ['yes', 'no', 'unknown'];

export const SPECIMEN_KINDS = Object.freeze([
  'webpage', 'screenshot_of_software', 'label_or_tag', 'packaging', 'point_of_sale_display',
  'advertising', 'brochure', 'photo_of_goods', 'other',
]);

export const TRANSFER_CHOICES = Object.freeze(['wait', 'file_now_move_later', 'successor']);

/** The answer keys a person (or a bot relaying them) may set — an allowlist. */
export const CLASS_KEYS = Object.freeze([
  'identification', 'id_source', 'id_manual_entry', 'in_use', 'basis', 'first_use_anywhere', 'first_use_in_commerce', 'intent_evidence',
]);
export const SPECIMEN_KEYS = Object.freeze([
  'document_id', 'kind', 'description', 'url', 'access_date', 'shows_mark', 'mark_as_brand', 'shows_services',
  'services_available', 'goods_sold', 'means_of_ordering', 'mockup',
]);
export const TRANSFER_KEYS = Object.freeze(['planned', 'entity_name', 'entity_formed', 'choice', 'wait_until']);

const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).trim().slice(0, max));
const date = (v) => { const s = str(v, 10); return DATE_RE.test(s) ? s : ''; };
const tri = (v) => {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  const s = str(v, 10).toLowerCase();
  return TRI.includes(s) ? s : '';
};
const bool = (v) => (v === true || v === 'yes' ? true : v === false || v === 'no' ? false : null);
const code3 = (v) => { const s = String(v ?? '').replace(/\D/g, ''); return s ? s.padStart(3, '0').slice(-3) : ''; };

function normalizeSpecimen(s) {
  const x = s && typeof s === 'object' ? s : {};
  const kind = SPECIMEN_KINDS.includes(x.kind) ? x.kind : '';
  return {
    document_id: typeof x.document_id === 'string' && UUID_RE.test(x.document_id) ? x.document_id : '',
    kind,
    description: str(x.description, 2000),
    url: str(x.url, 1000),
    access_date: date(x.access_date),
    // The checklist, answered by the person (yes / no / unknown):
    shows_mark: tri(x.shows_mark),                  // the mark appears on the specimen
    mark_as_brand: tri(x.mark_as_brand),            // as a brand for the goods/services, not only as a feature's name
    shows_services: tri(x.shows_services),          // services: the page offers the services under the mark
    services_available: tri(x.services_available),  // services: actually rendered now, not "coming soon"
    goods_sold: tri(x.goods_sold),                  // goods: sold or transported in commerce
    means_of_ordering: tri(x.means_of_ordering),    // goods, webpage: price / cart / ordering information
    mockup: tri(x.mockup),                          // a mockup, rendering or digitally altered image
  };
}

function normalizeEvidence(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((e) => ({
    date: date(e?.date), description: str(e?.description, 500),
  })).filter((e) => e.description);
}

function normalizeClass(c) {
  const x = c && typeof c === 'object' ? c : {};
  return {
    code: code3(x.code),
    identification: str(x.identification, 4000),
    id_source: ['id_manual', 'free_form'].includes(x.id_source) ? x.id_source : '',
    id_manual_entry: str(x.id_manual_entry, 200),
    in_use: bool(x.in_use),
    basis: ['1a', '1b'].includes(x.basis) ? x.basis : '',
    first_use_anywhere: date(x.first_use_anywhere),
    first_use_in_commerce: date(x.first_use_in_commerce),
    specimen: normalizeSpecimen(x.specimen),
    intent_evidence: normalizeEvidence(x.intent_evidence),
  };
}

/** The stored answers, cleaned (missing pieces become empty, never invented). */
export function normalizeApplication(app) {
  const a = app && typeof app === 'object' ? app : {};
  const seen = new Set();
  const classes = (Array.isArray(a.classes) ? a.classes : []).map(normalizeClass)
    .filter((c) => /^\d{3}$/.test(c.code) && !seen.has(c.code) && seen.add(c.code));
  const t = a.transfer && typeof a.transfer === 'object' ? a.transfer : {};
  return {
    classes,
    transfer: {
      planned: tri(t.planned),
      entity_name: str(t.entity_name, 300),
      entity_formed: bool(t.entity_formed),
      choice: TRANSFER_CHOICES.includes(t.choice) ? t.choice : '',
      wait_until: date(t.wait_until),
    },
    filing_date_planned: date(a.filing_date_planned),
    // The last DRAFT filed in the matter (tm_application_draft / the browser):
    // {document_id, annex_document_id, sha256, date, via}. Not an answer.
    draft: a.draft && typeof a.draft === 'object' && typeof a.draft.document_id === 'string' && UUID_RE.test(a.draft.document_id)
      ? {
        document_id: a.draft.document_id,
        annex_document_id: typeof a.draft.annex_document_id === 'string' && UUID_RE.test(a.draft.annex_document_id) ? a.draft.annex_document_id : null,
        sha256: /^[0-9a-f]{64}$/.test(String(a.draft.sha256 ?? '')) ? a.draft.sha256 : null,
        date: date(a.draft.date), via: str(a.draft.via, 100),
      }
      : null,
    updated_at: typeof a.updated_at === 'string' ? a.updated_at : null,
  };
}

/** The applicant block's fields this stage reads (tm_clearances.applicant). */
export const APPLICANT_FIELDS = Object.freeze([
  'legal_name', 'entity_type', 'state', 'formation_status', 'formation_date', 'domicile_address', 'mailing_address',
  'address_is_mail_drop', 'email',
]);

export function normalizeApplicant(a) {
  const x = a && typeof a === 'object' ? a : {};
  return {
    legal_name: str(x.legal_name, 300),
    entity_type: str(x.entity_type, 100),
    state: str(x.state, 100),
    formation_status: ['formed', 'pending', 'individual'].includes(x.formation_status) ? x.formation_status : '',
    formation_date: date(x.formation_date),
    domicile_address: str(x.domicile_address, 500),
    mailing_address: str(x.mailing_address, 500),
    address_is_mail_drop: tri(x.address_is_mail_drop),
    email: str(x.email, 200),
  };
}

/**
 * Fold answers into the stored application and applicant. Only the keys the
 * person gave change; a class not yet listed is added when it is one of the
 * filing classes. Returns {application, applicant, fields, refused}.
 * @param {object} o
 * @param {object} o.application   tm_clearances.application
 * @param {object} o.applicant     tm_clearances.applicant
 * @param {{code:string}[]} o.filingClasses
 * @param {object} o.answers       {applicant?, classes?: [{code, ...}], transfer?, filing_date_planned?}
 */
export function mergeAnswers({ application, applicant, filingClasses = [], answers = {} }) {
  const app = normalizeApplication(application);
  const appl = normalizeApplicant(applicant);
  const fields = new Set();
  const refused = [];

  if (answers.applicant && typeof answers.applicant === 'object') {
    for (const k of APPLICANT_FIELDS) {
      if (answers.applicant[k] !== undefined) { appl[k] = answers.applicant[k]; fields.add(`applicant.${k}`); }
    }
  }
  const filing = new Set(filingClasses.map((c) => code3(c.code)));
  for (const raw of Array.isArray(answers.classes) ? answers.classes : []) {
    const code = code3(raw?.code);
    if (!filing.has(code)) { refused.push(`class ${code || '?'}: not a filing class of this clearance`); continue; }
    let row = app.classes.find((c) => c.code === code);
    if (!row) { row = normalizeClass({ code }); app.classes.push(row); }
    for (const k of CLASS_KEYS) {
      if (raw[k] === undefined) continue;
      row[k] = raw[k];
      fields.add(`classes.${k}`);
    }
    if (raw.specimen && typeof raw.specimen === 'object' && !Array.isArray(raw.specimen)) {
      for (const sk of SPECIMEN_KEYS) {
        if (raw.specimen[sk] === undefined) continue;
        row.specimen = { ...row.specimen, [sk]: raw.specimen[sk] };
        fields.add(`classes.specimen.${sk}`);
      }
    }
  }
  if (answers.transfer && typeof answers.transfer === 'object') {
    for (const k of TRANSFER_KEYS) {
      if (answers.transfer[k] === undefined) continue;
      app.transfer = { ...app.transfer, [k]: answers.transfer[k] };
      fields.add(`transfer.${k}`);
    }
  }
  if (answers.filing_date_planned !== undefined) { app.filing_date_planned = answers.filing_date_planned; fields.add('filing_date_planned'); }

  const out = normalizeApplication({ ...app, classes: app.classes.filter((c) => filing.has(c.code)) });
  // Keep the filing classes' order.
  out.classes.sort((a, b) => a.code.localeCompare(b.code));
  return { application: out, applicant: normalizeApplicant(appl), fields: [...fields].sort(), refused };
}

/** A rule's citation, as printed: "[V 2026-10-21, 15 U.S.C. § 1127 (Cornell LII)]" or "[M]". */
export function cite(id) {
  const r = RULES.rules[id];
  if (!r) return '[M]';
  return r.verified ? `[V ${r.verified}, ${r.source}]` : `[M${r.source ? `, ${r.source}` : ''}]`;
}

/** The rule's plain-language text plus its citation. */
export const ruleText = (id) => `${RULES.rules[id]?.text ?? ''} ${cite(id)}`.trim();

// -----------------------------------------------------------------------------
// The specimen check (advisory)
// -----------------------------------------------------------------------------
const WORDS = Object.freeze({
  notYet: /\b(coming soon|launching|pre-?launch|wait ?list|join the list|notify me|sign up for early access|early access|pre-?order|beta sign-?up|not yet available)\b/i,
  feature: /\b(feature|in-app|in-product|credits?|tokens?|points?|units?|a setting|a button|menu item)\b/i,
  mockup: /\b(mock-?up|mock up|rendering|render|digitally (created|altered)|photoshop(ped)?|concept image|placeholder)\b/i,
  reserve: /\b(reserve the name|hold the name|placeholder site|parked)\b/i,
});

/**
 * Advisory flags for one class's specimen. The reviewer decides; nothing here
 * rejects a specimen. Each flag carries the rule it rests on.
 * @returns {{id:string, severity:'flag'|'question', text:string}[]}
 */
export function specimenCheck(cls) {
  const c = normalizeClass(cls);
  const s = c.specimen;
  const out = [];
  if (c.in_use !== true) return out;
  const services = isServiceClass(c.code);
  const text = `${s.description} ${s.url}`;
  const add = (id, severity, text) => out.push({ id, severity, text });

  if (!s.document_id) add('no_specimen', 'question', `No specimen is attached for class ${c.code}. A use-based class needs one per class. ${cite('specimen_required')}`);
  if (s.shows_mark === 'no') add('mark_absent', 'flag', `The specimen does not show the mark. ${cite('specimen_required')}`);
  if (s.mockup === 'yes' || WORDS.mockup.test(text)) {
    add('mockup', 'flag', `The specimen may be a mockup, rendering or digitally altered image, which is not acceptable as a specimen. ${cite('specimen_not_digitally_created')}`);
  }
  if (WORDS.reserve.test(text)) {
    add('token_use', 'flag', `Use made merely to reserve a right in a mark is not use in commerce. ${cite('use_in_commerce_bona_fide')}`);
  }
  if (s.mark_as_brand === 'no' || (s.mark_as_brand !== 'yes' && WORDS.feature.test(s.description))) {
    add('feature_name', 'flag', services
      ? `The term may appear only as the name of a feature or an in-product unit, not as a brand for the service. ${ruleText('feature_not_service')} ${cite('service_mark_association')}`
      : `The term may appear only as the name of a feature or component, not as a brand for the goods. ${cite('specimen_shows_mark_as_mark')}`);
  }
  if (s.kind === 'webpage' && (!s.url || !s.access_date)) {
    add('webpage_url_date', 'flag', `A webpage specimen needs its URL and the date it was accessed or printed. ${cite('specimen_webpage_url_date')}`);
  }
  if (services) {
    if (s.services_available === 'no' || WORDS.notYet.test(text)) {
      add('not_rendered', 'flag', `Advertising a service that is not yet available is not use: the services must be rendered in commerce. ${cite('use_in_commerce_services')} ${cite('services_rendered_not_future')}`);
    }
    if (s.shows_services === 'no') add('no_association', 'flag', `The specimen must show the mark used in the sale or advertising of the services and associate it with them. ${cite('service_mark_association')}`);
    if (s.services_available === '' || s.services_available === 'unknown') add('ask_rendered', 'question', `Are the services actually being rendered now (a customer can use them today)? ${cite('use_in_commerce_services')}`);
    if (s.shows_services === '' || s.shows_services === 'unknown') add('ask_association', 'question', 'Does the specimen show the services being offered under the mark (not only the mark on its own)?');
  } else {
    if (['advertising', 'brochure'].includes(s.kind)) {
      add('goods_advertising', 'flag', `For goods, advertising material is generally not an acceptable specimen; the mark should appear on the goods, their packaging or tags, or a point-of-sale display. ${cite('specimen_goods')}`);
    }
    if (s.kind === 'webpage' && s.means_of_ordering === 'no') {
      add('webpage_no_ordering', 'flag', `A webpage is a display associated with the goods only when it shows the mark near the goods and a means of ordering them. ${cite('specimen_goods_webpage')}`);
    }
    if (s.goods_sold === 'no') add('goods_not_sold', 'flag', `The goods must be sold or transported in commerce under the mark. ${cite('use_in_commerce_goods')}`);
    if (s.goods_sold === '' || s.goods_sold === 'unknown') add('ask_goods_sold', 'question', `Have the goods been sold or transported in commerce under the mark? ${cite('use_in_commerce_goods')}`);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Basis
// -----------------------------------------------------------------------------
/**
 * The recommended basis for one class, with the reason. The reviewer decides.
 * @returns {{basis:'1a'|'1b'|null, reason:string}}
 */
export function recommendBasis(cls, today) {
  const c = normalizeClass(cls);
  if (c.in_use === null) return { basis: null, reason: 'Ask first: is the mark in use in commerce for these goods or services now?' };
  if (c.in_use === false) {
    return { basis: '1b', reason: `Not in use yet: intent to use, Section 1(b). ${cite('basis_1b')}` };
  }
  const problems = [];
  if (!c.first_use_anywhere) problems.push('the date of first use anywhere');
  if (!c.first_use_in_commerce) problems.push('the date of first use in commerce');
  if (c.first_use_anywhere && c.first_use_in_commerce && c.first_use_anywhere > c.first_use_in_commerce) problems.push('dates in order (first use anywhere cannot be after first use in commerce)');
  if (today && c.first_use_in_commerce && c.first_use_in_commerce > today) problems.push('a first-use date that is not in the future');
  const flags = specimenCheck(c).filter((f) => f.severity === 'flag');
  if (!c.specimen.document_id) problems.push('a specimen');
  if (!problems.length && !flags.length) {
    return { basis: '1a', reason: `In use, with dates and a specimen: use in commerce, Section 1(a). ${cite('basis_1a')}` };
  }
  return {
    basis: '1b',
    reason: `In use, but ${[...problems.length ? [`missing ${problems.join(', ')}`] : [], ...flags.length ? [`the specimen check raised ${flags.length} flag${flags.length === 1 ? '' : 's'}`] : []].join('; ')}. ` +
      'Until that is fixed, intent to use (Section 1(b)) is the basis that does not depend on the specimen; ' +
      `use can be alleged later. The reviewer decides. ${cite('basis_1b')}`,
  };
}

// -----------------------------------------------------------------------------
// Entity, domicile, assignment
// -----------------------------------------------------------------------------
/**
 * @returns {{id:string, severity:'block'|'flag'|'note', text:string}[]} and doNotFileBefore
 */
export function entityCautions({ applicant, application, today }) {
  const a = normalizeApplicant(applicant);
  const app = normalizeApplication(application);
  const out = [];
  let doNotFileBefore = null;
  const add = (id, severity, text) => out.push({ id, severity, text });
  const filingDate = app.filing_date_planned || today;
  const bases = new Set(app.classes.map((c) => c.basis || recommendBasis(c, today).basis).filter(Boolean));

  if (a.formation_status === 'pending' || (a.formation_date && filingDate && a.formation_date > filingDate)) {
    add('applicant_not_formed', 'block',
      `${a.legal_name || 'The applicant'} is not formed yet${a.formation_date ? ` (formation date ${a.formation_date})` : ''}. ${ruleText('applicant_must_exist')}`);
    if (a.formation_date) doNotFileBefore = a.formation_date;
  }
  if (a.address_is_mail_drop === 'yes') {
    add('domicile_mail_drop', 'block', `The domicile address must be where the applicant's principal place of business is (or, for a person, where they live); a P.O. box, mail drop or similar address is not a domicile. ${cite('domicile')}`);
  } else if (!a.address_is_mail_drop || a.address_is_mail_drop === 'unknown') {
    add('domicile_ask', 'flag', `Confirm the domicile address is a street address of the principal place of business, not a P.O. box, PMB or mail drop. ${cite('domicile')}`);
  }

  const t = app.transfer;
  if (t.planned === 'yes' && t.entity_formed !== true) {
    const who = t.entity_name || 'an entity not yet formed';
    add('transfer_options', 'flag', [
      `The marks are to move to ${who}. The options:`,
      `(1) Wait: form the entity first and file in its name${t.wait_until ? ` (not before ${t.wait_until})` : ''}.`,
      `(2) File now as ${a.legal_name || 'the existing applicant'} and move the marks later, together with the business they belong to.`,
      '(3) File now and assign to the new entity as successor to the business, with care.',
      bases.has('1b')
        ? `For an intent-to-use (Section 1(b)) class, the application cannot be assigned before an allegation of use is filed, except to a successor to the applicant's business, or the portion of it to which the mark pertains, if that business is ongoing and existing. ${cite('itu_assignment_bar')}`
        : '',
      bases.has('1a')
        ? `A use-based (Section 1(a)) class has no such bar; any assignment must still carry the goodwill of the business the mark symbolizes. ${cite('assignment_goodwill')}`
        : '',
    ].filter(Boolean).join(' '));
    if (t.choice === 'wait') doNotFileBefore = t.wait_until || doNotFileBefore || (a.formation_date || null);
    if (!t.choice) add('transfer_choose', 'flag', 'Choose one of the three options before the draft is signed off.');
    if (t.choice === 'successor' && bases.has('1b')) {
      add('successor_care', 'flag', `The successor exception needs the new entity to take over the ongoing and existing business to which the mark pertains, not only the mark. ${cite('itu_assignment_bar')}`);
    }
  }
  if (!a.legal_name) add('applicant_name', 'block', 'The applicant\'s exact legal name is needed.');
  return { cautions: out, doNotFileBefore };
}

// -----------------------------------------------------------------------------
// Questions
// -----------------------------------------------------------------------------
/**
 * Everything still needed before the draft can be assembled, in the order a
 * person should be asked. `blocking` items stop assembly; the rest are asked
 * but the draft can be assembled with them shown as gaps.
 * @returns {{id:string, about:string, question:string, blocking:boolean, field:string}[]}
 */
export function applicationQuestions({ clearance, today }) {
  const c = clearance;
  const a = normalizeApplicant(c.applicant);
  const app = normalizeApplication(c.application);
  const q = [];
  const ask = (id, about, question, blocking, field) => q.push({ id, about, question, blocking, field });

  if (!(c.filing_classes ?? []).length) {
    ask('filing_classes', 'classes', 'No filing classes are confirmed. Confirm the filing classes (each needs dated evidence of a bona fide intent) first.', true, 'filing_classes');
  }
  if (!a.legal_name) ask('applicant.legal_name', 'applicant', 'What is the applicant\'s exact legal name (e.g. "Grapheon.ai, LLC")?', true, 'applicant.legal_name');
  if (!a.entity_type) ask('applicant.entity_type', 'applicant', 'What kind of entity is the applicant (limited liability company, corporation, individual …)?', true, 'applicant.entity_type');
  if (!a.state && a.formation_status !== 'individual') ask('applicant.state', 'applicant', 'In which state (or country) is the applicant organized?', true, 'applicant.state');
  if (!a.formation_status) ask('applicant.formation_status', 'applicant', 'Has the applicant been formed already (formed / pending / an individual)?', true, 'applicant.formation_status');
  if (a.formation_status !== 'individual' && !a.formation_date) ask('applicant.formation_date', 'applicant', 'On what date was (or will) the applicant be formed?', false, 'applicant.formation_date');
  if (!a.domicile_address) ask('applicant.domicile_address', 'applicant', 'What is the applicant\'s domicile: the street address of its principal place of business?', true, 'applicant.domicile_address');
  if (!a.address_is_mail_drop || a.address_is_mail_drop === 'unknown') ask('applicant.address_is_mail_drop', 'applicant', 'Is that address a P.O. box, PMB or mail drop (yes / no)?', true, 'applicant.address_is_mail_drop');
  if (!a.email) ask('applicant.email', 'applicant', 'What email address should the USPTO use for correspondence?', false, 'applicant.email');

  for (const fc of c.filing_classes ?? []) {
    const row = app.classes.find((x) => x.code === fc.code) ?? normalizeClass({ code: fc.code });
    const k = `classes.${fc.code}`;
    if (!row.identification) ask(`${k}.identification`, `class ${fc.code}`, `How should the goods or services in class ${fc.code} be identified? An ID Manual entry is preferred; free-form wording carries a surcharge.`, true, `${k}.identification`);
    else if (!row.id_source) ask(`${k}.id_source`, `class ${fc.code}`, `Is the class ${fc.code} identification taken from the ID Manual (give the entry), or free-form?`, false, `${k}.id_source`);
    if (row.in_use === null) {
      ask(`${k}.in_use`, `class ${fc.code}`, `Is ${c.mark} in use in commerce now for the class ${fc.code} goods or services (yes / no)?`, true, `${k}.in_use`);
      continue;
    }
    if (row.in_use) {
      if (!row.first_use_anywhere) ask(`${k}.first_use_anywhere`, `class ${fc.code}`, `Date of first use of ${c.mark} anywhere, for class ${fc.code} (YYYY-MM-DD)?`, false, `${k}.first_use_anywhere`);
      if (!row.first_use_in_commerce) ask(`${k}.first_use_in_commerce`, `class ${fc.code}`, `Date of first use in commerce, for class ${fc.code} (YYYY-MM-DD)?`, false, `${k}.first_use_in_commerce`);
      if (!row.specimen.document_id) ask(`${k}.specimen.document_id`, `class ${fc.code}`, `Upload a specimen for class ${fc.code} into the matter (a page or photo showing the mark as used) and give its document id.`, false, `${k}.specimen.document_id`);
      for (const f of specimenCheck(row).filter((x) => x.severity === 'question' && x.id !== 'no_specimen')) {
        ask(`${k}.specimen.${f.id}`, `class ${fc.code}`, f.text, false, `${k}.specimen`);
      }
    } else if (!row.intent_evidence.length) {
      ask(`${k}.intent_evidence`, `class ${fc.code}`, `List the dated evidence of a bona fide intent to use ${c.mark} for class ${fc.code} (business plans, product specifications, budgets, correspondence), each with its date.`, false, `${k}.intent_evidence`);
    }
    if (!row.basis) {
      const r = recommendBasis(row, today);
      if (r.basis) ask(`${k}.basis`, `class ${fc.code}`, `Recommended basis for class ${fc.code}: Section ${r.basis === '1a' ? '1(a), use' : '1(b), intent to use'}. ${r.reason} Which basis should the draft use?`, false, `${k}.basis`);
    }
  }
  const t = app.transfer;
  if (!t.planned) ask('transfer.planned', 'transfer', 'Will these marks move later to another entity (for example one not formed yet)? (yes / no)', false, 'transfer.planned');
  else if (t.planned === 'yes' && t.entity_formed === null) ask('transfer.entity_formed', 'transfer', 'Has that entity been formed already?', false, 'transfer.entity_formed');
  else if (t.planned === 'yes' && t.entity_formed === false && !t.choice) {
    ask('transfer.choice', 'transfer', 'Which option: wait and file in the new entity\'s name; file now and move the marks later with the business; or rely on the successor exception, with care?', false, 'transfer.choice');
  }
  return q;
}

// -----------------------------------------------------------------------------
// Fees
// -----------------------------------------------------------------------------
/**
 * @returns {{lines:{label:string, per:number, count:number, total:number, when:string, cite:string}[], dueAtFiling:number, later:{label:string, amount:string}[]}}
 */
export function feeEstimate({ classes, applicantComplete = true }) {
  const F = RULES.fees;
  const n = classes.length;
  const freeForm = classes.filter((c) => c.id_source !== 'id_manual').length;
  const itu = classes.filter((c) => c.basis === '1b').length;
  const lines = [{ label: F.base.label, per: F.base.amount, count: n, total: F.base.amount * n, when: 'at filing', cite: citeFee() }];
  if (freeForm) lines.push({ label: F.free_form.label, per: F.free_form.amount, count: freeForm, total: F.free_form.amount * freeForm, when: 'at filing', cite: citeFee() });
  const extra = classes.filter((c) => c.id_source !== 'id_manual')
    .reduce((sum, c) => sum + Math.max(0, Math.ceil(((c.identification ?? '').length - 1000) / 1000)), 0);
  if (extra) lines.push({ label: F.excess_characters.label, per: F.excess_characters.amount, count: extra, total: F.excess_characters.amount * extra, when: 'at filing', cite: citeFee() });
  if (!applicantComplete) lines.push({ label: F.insufficient_information.label, per: F.insufficient_information.amount, count: n, total: F.insufficient_information.amount * n, when: 'at filing, if required information is missing', cite: citeFee() });
  const later = [];
  if (itu) {
    later.push({ label: `${F.allegation_of_use.label} (${itu} intent-to-use class${itu === 1 ? '' : 'es'})`, amount: `$${F.allegation_of_use.amount} per class` });
    later.push({ label: F.sou_extension.label, amount: `$${F.sou_extension.amount} per class, each extension` });
  }
  return { lines, dueAtFiling: lines.reduce((s, l) => s + l.total, 0), later };
}

const citeFee = () => (RULES.fees.verified ? `[V ${RULES.fees.verified}, ${RULES.fees.source}]` : `[M, ${RULES.fees.source}]`);

// -----------------------------------------------------------------------------
// The draft and the annex
// -----------------------------------------------------------------------------
function table(headers, rows) {
  if (!rows.length) return '_None._\n';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n') + '\n';
}

const BASIS_LABEL = { '1a': 'Section 1(a) — use in commerce', '1b': 'Section 1(b) — intent to use' };

export function applicationFilename(mark, date, kind = 'draft') {
  const safe = String(mark ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'MARK';
  return kind === 'annex'
    ? `Trademark application cautions — ${safe} — ${date}.md`
    : kind === 'reviewed'
      ? `Trademark application (reviewed) — ${safe} — ${date}.md`
      : `Trademark application draft — ${safe} — ${date}.md`;
}

export function draftLegend({ via, date, doNotFileBefore }) {
  return [
    `> **DRAFT — NOT REVIEWED.** Assembled ${via ? `through ${via} ` : ''}on ${date}. It is not signed and not filed with the USPTO.`,
    '> The reviewer signs this stage off in the matter\'s Trademark tab; the applicant (or its attorney) signs the declaration and files in TEAS.',
    ...(doNotFileBefore ? [`> **Do not file before ${doNotFileBefore}.**`] : []),
    '',
  ].join('\n');
}

export function reviewedLegend({ initials, date, doNotFileBefore }) {
  return [
    `> **Reviewed — ${initials}, ${date}.** Not filed: the applicant (or its attorney) signs the declaration and files in TEAS.`,
    ...(doNotFileBefore ? [`> **Do not file before ${doNotFileBefore}.**`] : []),
    '',
  ].join('\n');
}

/**
 * Assemble the application draft (TEAS order) and the separate cautions annex.
 * Deterministic: the same inputs give the same bytes.
 * @param {object} o
 * @param {object} o.clearance   tm_clearances row (applicant, application, filing_classes, mark, mark_format)
 * @param {object[]} [o.hits]    tm_hits rows (for the deep check summary in the annex)
 * @param {{stage6?:string, stage8?:string, reportDocumentId?:string|null}} [o.stages]
 * @param {string} o.today       YYYY-MM-DD
 * @returns {{draft:string, annex:string, doNotFileBefore:string|null, bases:Record<string,string>, blocking:string[], lint:{phrase:string, sentence:string}[]}}
 */
export function assembleApplication({ clearance, hits = [], stages = {}, today }) {
  const c = clearance;
  const a = normalizeApplicant(c.applicant);
  const app = normalizeApplication(c.application);
  const filing = (c.filing_classes ?? []).map((fc) => app.classes.find((x) => x.code === fc.code) ?? normalizeClass({ code: fc.code }));
  const withBasis = filing.map((x) => ({ ...x, basis: x.basis || recommendBasis(x, today).basis || '' }));
  const { cautions, doNotFileBefore } = entityCautions({ applicant: a, application: { ...app, classes: withBasis }, today });
  const questions = applicationQuestions({ clearance: { ...c, applicant: a, application: app }, today });
  const blocking = questions.filter((x) => x.blocking).map((x) => x.question);
  const applicantComplete = Boolean(a.legal_name && a.entity_type && a.domicile_address && (a.state || a.formation_status === 'individual'));
  const fees = feeEstimate({ classes: withBasis, applicantComplete });

  const d = [];
  d.push(`# Trademark application draft — ${c.mark}`, '');
  d.push(`Prepared ${today} from this matter's clearance, in the order the USPTO's TEAS form asks for it. ` +
    'Copy each item into TEAS; the declaration is signed there.', '');

  d.push('## 1. Applicant', '');
  d.push(table(['Field', 'Value'], [
    ['Name', a.legal_name || '— needed —'],
    ['Entity type', a.entity_type || '— needed —'],
    ['State or country of organization', a.state || (a.formation_status === 'individual' ? '(individual: citizenship)' : '— needed —')],
    ['Formation date', a.formation_date || (a.formation_status === 'individual' ? 'n/a' : '— needed —')],
    ['Domicile address', a.domicile_address || '— needed —'],
    ['Mailing address', a.mailing_address || a.domicile_address || '— needed —'],
    ['Email', a.email || '— needed —'],
  ]));

  d.push('## 2. Mark', '');
  d.push(table(['Field', 'Value'], [
    ['Mark', c.mark],
    ['Format', c.mark_format === 'stylized' ? 'Special form (stylized or design): a drawing is needed' : 'Standard characters (no claim to font, style, size or color)'],
  ]));

  d.push('## 3. Classes and identifications', '');
  d.push(table(['Class', 'Identification', 'Source'], withBasis.map((x) => [
    x.code, x.identification || '— needed —',
    x.id_source === 'id_manual' ? `ID Manual${x.id_manual_entry ? ` (${x.id_manual_entry})` : ''}` : x.identification ? 'Free-form (surcharge)' : '',
  ])));

  d.push('## 4. Basis and dates', '');
  d.push(table(['Class', 'Basis', 'First use anywhere', 'First use in commerce'], withBasis.map((x) => [
    x.code, x.basis ? `${BASIS_LABEL[x.basis]}${filing.find((f) => f.code === x.code)?.basis ? '' : ' (recommended; the reviewer confirms)'}` : '— in use? —',
    x.basis === '1a' ? (x.first_use_anywhere || '— needed —') : '',
    x.basis === '1a' ? (x.first_use_in_commerce || '— needed —') : '',
  ])));

  d.push('## 5. Specimens', '');
  const used = withBasis.filter((x) => x.basis === '1a');
  d.push(used.length ? table(['Class', 'Specimen', 'Description', 'URL and access date'], used.map((x) => [
    x.code, x.specimen.document_id ? `document ${x.specimen.document_id}${x.specimen.kind ? ` (${x.specimen.kind.replace(/_/g, ' ')})` : ''}` : '— needed —',
    x.specimen.description || '— describe what the specimen shows —',
    x.specimen.kind === 'webpage' ? `${x.specimen.url || '— URL —'}, accessed ${x.specimen.access_date || '— date —'}` : '',
  ])) : '_No use-based class: no specimen is filed with an intent-to-use application; one is filed with the allegation of use._\n');

  d.push('## 6. Declaration', '');
  d.push('Signed in TEAS by the applicant or its attorney; the form presents the full text. What it verifies, in substance, by basis:', '');
  if (withBasis.some((x) => x.basis === '1a')) d.push(`- Use-based classes: ${ruleText('declaration_1a')}`);
  if (withBasis.some((x) => x.basis === '1b')) d.push(`- Intent-to-use classes: ${ruleText('declaration_1b')}`);
  d.push(`- ${ruleText('declaration_false_statements')}`, '');

  d.push('## 7. Fees', '');
  d.push(table(['Fee', 'Per class', 'Classes', 'Amount', 'When'], fees.lines.map((l) => [l.label, `$${l.per}`, l.count, `$${l.total}`, l.when])));
  d.push(`Due at filing: $${fees.dueAtFiling}. ${citeFee()}`, '');
  if (fees.later.length) d.push('Later, for the intent-to-use classes:', '', ...fees.later.map((l) => `- ${l.label}: ${l.amount}`), '');
  d.push(`Fees re-verified ${RULES.fees.verified || '— not verified —'}; check the USPTO fee page on the day of filing.`, '');

  // ------------------------------------------------------------------ annex
  const n = [];
  n.push(`# Trademark application cautions — ${c.mark}`, '');
  n.push('Not part of the filing. For the reviewer, with the draft of the same date.', '');
  if (doNotFileBefore) n.push(`**Do not file before ${doNotFileBefore}.**`, '');
  n.push('## Still needed', '');
  n.push(questions.length ? questions.map((x) => `- ${x.blocking ? '**Needed:** ' : ''}${x.question}`).join('\n') + '\n' : '_Nothing._\n');
  n.push('## Applicant and entity', '');
  n.push(cautions.length ? cautions.map((x) => `- ${x.severity === 'block' ? '**' : ''}${x.text}${x.severity === 'block' ? '**' : ''}`).join('\n') + '\n' : '_No caution._\n');
  n.push('## Basis per class', '');
  n.push(table(['Class', 'Chosen', 'Recommended', 'Why'], filing.map((x) => {
    const r = recommendBasis(x, today);
    return [x.code, x.basis ? BASIS_LABEL[x.basis] : '— not chosen —', r.basis ? BASIS_LABEL[r.basis] : '—', r.reason];
  })));
  n.push('## Specimen check (advisory; the reviewer decides)', '');
  const flags = withBasis.flatMap((x) => specimenCheck(x).map((f) => [x.code, f.severity === 'flag' ? 'Flag' : 'Question', f.text]));
  n.push(used.length ? table(['Class', 'Kind', 'Point'], flags) : '_No use-based class._\n');
  if (used.length) {
    n.push(`What a specimen must show: for goods, ${RULES.rules.use_in_commerce_goods?.text ?? ''} ${cite('use_in_commerce_goods')}; ` +
      `for services, ${RULES.rules.use_in_commerce_services?.text ?? ''} ${cite('use_in_commerce_services')}. ` +
      `${ruleText('services_payment_not_required')}`, '');
  }
  n.push('## Bona fide intent (intent-to-use classes)', '');
  const itu = withBasis.filter((x) => x.basis === '1b');
  n.push(itu.length
    ? `${ruleText('bona_fide_intent_evidence')}\n\n` + table(['Class', 'Date', 'Evidence'], itu.flatMap((x) => (x.intent_evidence.length
      ? x.intent_evidence.map((e) => [x.code, e.date || '— undated —', e.description])
      : [[x.code, '', '— none listed —']])))
    : '_No intent-to-use class._\n');
  n.push('## Identifications', '');
  const ff = withBasis.filter((x) => x.identification && x.id_source !== 'id_manual');
  n.push(ff.length ? `${ff.map((x) => `Class ${x.code}`).join(', ')}: free-form wording. ${ruleText('free_form_surcharge')}\n` : '_All identifications are from the ID Manual._\n');
  n.push('## The register: official status of the flagged records (stage 6)', '');
  const checked = hits.filter((h) => h.tsdr);
  n.push(checked.length ? table(['Serial', 'Mark', 'Owner', 'Official status', 'Live', 'Registration', 'Classes', 'Record'], checked.map((h) => [
    h.serial, h.tsdr.mark || h.mark, h.tsdr.owner || h.owner,
    h.tsdr.error ? `not fetched — ${h.tsdr.error}` : [h.tsdr.status_code, h.tsdr.status_text].filter(Boolean).join(' — '),
    h.tsdr.live === true ? 'live' : h.tsdr.live === false ? 'dead (noted, not dropped)' : '?',
    [h.tsdr.registration_number, h.tsdr.registration_date].filter(Boolean).join(', '), (h.tsdr.classes ?? []).join(' '),
    h.tsdr_document_id ? `document ${h.tsdr_document_id}` : '',
  ])) : `_No official status was fetched${stages.stage6 === 'skipped' ? ' (stage 6 was skipped by the reviewer)' : ''}._\n`);
  n.push(`Knockout report: ${stages.stage8 === 'done' ? `signed off${stages.reportDocumentId ? ` (document ${stages.reportDocumentId})` : ''}` : 'not yet signed off'}.`, '');
  n.push('## Deadlines after filing', '');
  n.push(`- ${ruleText('sou_deadline')}`, `- ${ruleText('office_action_response')}`, '');
  n.push('## Sources', '');
  n.push(table(['Rule', 'Source', 'Verified'], Object.entries(RULES.rules).map(([id, r]) => [id.replace(/_/g, ' '), r.source, r.verified || '[M] not verified'])));
  n.push(`Fees: ${RULES.fees.source}, ${RULES.fees.verified ? `verified ${RULES.fees.verified}` : '[M] not verified'}.`, '');

  const draft = d.join('\n').replace(/\n{3,}/g, '\n\n');
  const annex = n.join('\n').replace(/\n{3,}/g, '\n\n');
  const lint = [...forbiddenPhrases(draft), ...forbiddenPhrases(annex)].map((h) => ({ phrase: h.phrase, sentence: h.sentence }));
  const bases = Object.fromEntries(withBasis.map((x) => [x.code, x.basis || '']));
  return { draft, annex, doNotFileBefore, bases, blocking, lint, fees, questions, cautions };
}
