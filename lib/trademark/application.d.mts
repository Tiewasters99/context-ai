// Types for lib/trademark/application.mjs — stage 9, the application draft.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type Tri = 'yes' | 'no' | 'unknown' | '';
export type Basis = '1a' | '1b' | '';
export type SpecimenKind =
  | 'webpage' | 'screenshot_of_software' | 'label_or_tag' | 'packaging' | 'point_of_sale_display'
  | 'advertising' | 'brochure' | 'photo_of_goods' | 'other' | '';

export interface Specimen {
  document_id: string; kind: SpecimenKind; description: string; url: string; access_date: string;
  shows_mark: Tri; mark_as_brand: Tri; shows_services: Tri; services_available: Tri; goods_sold: Tri; means_of_ordering: Tri; mockup: Tri;
}
export interface AppClass {
  code: string; identification: string; id_source: 'id_manual' | 'free_form' | ''; id_manual_entry: string;
  in_use: boolean | null; basis: Basis; first_use_anywhere: string; first_use_in_commerce: string;
  specimen: Specimen; intent_evidence: { date: string; description: string }[];
}
export interface Transfer {
  planned: Tri; entity_name: string; entity_formed: boolean | null; choice: 'wait' | 'file_now_move_later' | 'successor' | ''; wait_until: string;
}
export interface Application {
  classes: AppClass[]; transfer: Transfer; filing_date_planned: string;
  draft: { document_id: string; annex_document_id: string | null; sha256: string | null; date: string; via: string } | null;
  updated_at: string | null;
}
export interface ApplicantBlock {
  legal_name: string; entity_type: string; state: string; formation_status: 'formed' | 'pending' | 'individual' | '';
  formation_date: string; domicile_address: string; mailing_address: string; address_is_mail_drop: Tri; email: string;
}
export interface Flag { id: string; severity: 'flag' | 'question'; text: string }
export interface Caution { id: string; severity: 'block' | 'flag' | 'note'; text: string }
export interface Question { id: string; about: string; question: string; blocking: boolean; field: string }

export const RULES: { version: number; about: string; rules: Record<string, { text: string; source: string; verified: string | null }>; fees: any };
export const SPECIMEN_KINDS: readonly SpecimenKind[];
export const TRANSFER_CHOICES: readonly string[];
export const CLASS_KEYS: readonly string[];
export const SPECIMEN_KEYS: readonly string[];
export const TRANSFER_KEYS: readonly string[];
export const APPLICANT_FIELDS: readonly string[];
export function isServiceClass(code: string): boolean;
export function normalizeApplication(app: unknown): Application;
export function normalizeApplicant(a: unknown): ApplicantBlock;
export function mergeAnswers(o: { application: unknown; applicant: unknown; filingClasses?: { code: string }[]; answers?: Record<string, any> }): {
  application: Application; applicant: ApplicantBlock; fields: string[]; refused: string[];
};
export function cite(id: string): string;
export function ruleText(id: string): string;
export function specimenCheck(cls: Partial<AppClass> & { code: string }): Flag[];
export function recommendBasis(cls: Partial<AppClass> & { code: string }, today?: string): { basis: '1a' | '1b' | null; reason: string };
export function entityCautions(o: { applicant: unknown; application: unknown; today?: string }): { cautions: Caution[]; doNotFileBefore: string | null };
export function applicationQuestions(o: { clearance: Record<string, any>; today?: string }): Question[];
export function feeEstimate(o: { classes: Partial<AppClass>[]; applicantComplete?: boolean }): {
  lines: { label: string; per: number; count: number; total: number; when: string; cite: string }[]; dueAtFiling: number; later: { label: string; amount: string }[];
};
export function applicationFilename(mark: string, date: string, kind?: 'draft' | 'annex' | 'reviewed'): string;
export function draftLegend(o: { via?: string; date: string; doNotFileBefore?: string | null }): string;
export function reviewedLegend(o: { initials: string; date: string; doNotFileBefore?: string | null }): string;
export function assembleApplication(o: {
  clearance: Record<string, any>; hits?: Record<string, any>[]; stages?: { stage6?: string; stage8?: string; reportDocumentId?: string | null }; today: string;
}): {
  draft: string; annex: string; doNotFileBefore: string | null; bases: Record<string, string>; blocking: string[];
  lint: { phrase: string; sentence: string }[]; fees: ReturnType<typeof feeEstimate>; questions: Question[]; cautions: Caution[];
};
