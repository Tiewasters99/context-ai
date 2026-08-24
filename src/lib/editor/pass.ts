/**
 * The editing pass — manuscript in, redline out.
 *
 * Orchestration per the charter: read for the argument (document plan) →
 * edit one section at a time from the plan → deterministic verification →
 * a blind critic reads the rewrite cold. Every LLM exchange is
 * provider-neutral structured output through src/lib/llm.
 */

import { generateStructured, findModel } from '@/lib/llm';
import { plannerSystem, sectionEditorSystem, lightEditorSystem, criticSystem } from './constitution';
import { verifyEdits, applyEdits, buildNormalized, normalize } from './verifier';
import type { RawEdit } from './verifier';
import {
  CORRECTIVE_MARKS,
  PRAISE_MARKS,
  type CorrectiveMark,
  type DocumentForm,
  type DocumentPlan,
  type EditorPassResult,
  type EditorProgress,
  type PraiseMark,
  type PraiseNote,
} from './types';

/**
 * The Editor's pen is Kimi K3, US-hosted — Eden's call (2026-08-18): a
 * talented writer at a fraction of frontier cost, served from the open
 * weights on Fireworks (US infrastructure, zero data retention) so client
 * material never routes abroad. If the pen is unavailable (no key on this
 * deployment, rate limit, outage), the pass falls back to Opus 4.8 — the
 * pen the Editor trained with — and says so in the pass notes. The
 * fallback is deliberately NOT Moonshot's own API: a silent failover must
 * never reroute a manuscript to a host with weaker data terms.
 */
export const DEFAULT_EDITOR_MODEL: string = 'kimi-k3-us';
export const FALLBACK_EDITOR_MODEL: string = 'claude-opus-4-8';

/** Below this size the section editor sees the whole manuscript for context. */
const FULL_CONTEXT_LIMIT = 12_000;

/**
 * At or below this size the Editor takes the manuscript in one sitting —
 * a single edit call instead of plan + per-section calls. Most of the
 * cost of a pass is the model's thinking, which is billed per call.
 */
const LIGHT_PASS_LIMIT = 7_000;

/** Sections are independent by design — a few desks work at once. */
const SECTION_CONCURRENCY = 3;

const PLAN_SCHEMA = {
  type: 'object',
  required: ['thesis', 'assessment', 'sections'],
  properties: {
    thesis: { type: 'string', description: 'What the document is trying to say, in one committed sentence.' },
    assessment: {
      type: 'string',
      description: "The Editor's overall structural assessment — where the structure serves the thesis and where it shows the AI voice.",
    },
    sections: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['title', 'firstWords', 'role'],
        properties: {
          title: { type: 'string', description: "The Editor's short label for the section." },
          firstWords: {
            type: 'string',
            description: 'The first 6–12 words of the section, copied VERBATIM character-for-character from the manuscript. Used mechanically to split the text.',
          },
          role: { type: 'string', description: 'What this section does for the thesis.' },
          structuralNote: { type: 'string', description: 'Section-level AI-structure diagnosis, if any.' },
        },
      },
    },
  },
} as const;

const SECTION_SCHEMA = {
  type: 'object',
  required: ['edits', 'praise'],
  properties: {
    edits: {
      type: 'array',
      description: 'Every passage flagged for correction, with the full work-product the charter requires. Flag nothing that does not need fixing.',
      items: {
        type: 'object',
        required: ['before', 'claim', 'failure', 'mark', 'authority', 'after'],
        properties: {
          before: {
            type: 'string',
            description: 'The flagged passage, VERBATIM character-for-character from the section, long enough to be unique in the whole document.',
          },
          claim: {
            type: 'string',
            description: 'PRODUCE THIS BEFORE THE REWRITE: what the passage asserts, in plain propositional form. Empty string if no claim extracts — that null result is the diagnosis.',
          },
          failure: { type: 'string', description: 'Why the current words fail to deliver the claim to the reader.' },
          mark: { type: 'string', enum: [...CORRECTIVE_MARKS], description: 'The one-word margin verdict.' },
          authority: { type: 'string', description: 'The principle, vocabulary entry, or image-bench test being applied.' },
          after: { type: 'string', description: 'The rewrite, generated from the claim. Empty string proposes a cut.' },
        },
      },
    },
    praise: {
      type: 'array',
      description: 'Passages that earn praise — recorded as carefully as corrections.',
      items: {
        type: 'object',
        required: ['quote', 'mark', 'note'],
        properties: {
          quote: { type: 'string', description: 'The praised passage, verbatim from the section.' },
          mark: { type: 'string', enum: [...PRAISE_MARKS] },
          note: { type: 'string', description: 'Why it earns the mark.' },
        },
      },
    },
  },
} as const;

const CRITIC_SCHEMA = {
  type: 'object',
  required: ['report', 'flags'],
  properties: {
    report: {
      type: 'string',
      description: 'Overall verdict: does this text still sound like a model, and where. If it reads clean, say so plainly.',
    },
    flags: {
      type: 'array',
      items: {
        type: 'object',
        required: ['quote', 'mark', 'note'],
        properties: {
          quote: { type: 'string', description: 'The offending passage, verbatim from the text you were given.' },
          mark: { type: 'string', enum: [...CORRECTIVE_MARKS] },
          note: { type: 'string', description: 'One sentence on the residual AI-ism.' },
        },
      },
    },
  },
} as const;

const LIGHT_SCHEMA = {
  type: 'object',
  required: ['thesis', 'assessment', 'edits', 'praise'],
  properties: {
    thesis: PLAN_SCHEMA.properties.thesis,
    assessment: PLAN_SCHEMA.properties.assessment,
    edits: SECTION_SCHEMA.properties.edits,
    praise: SECTION_SCHEMA.properties.praise,
  },
} as const;

interface ResolvedSection {
  title: string;
  role: string;
  structuralNote?: string;
  start: number;
  end: number;
}

/** Split the manuscript at the plan's verbatim anchors. Falls back to one whole-document section. */
function resolveSections(manuscript: string, plan: DocumentPlan, passNotes: string[]): ResolvedSection[] {
  const nm = buildNormalized(manuscript);
  const starts: Array<Omit<ResolvedSection, 'end'>> = [];
  let lastStart = -1;

  for (const section of plan.sections) {
    let idx = manuscript.indexOf(section.firstWords, lastStart + 1);
    if (idx === -1) {
      const anchor = normalize(section.firstWords).trim();
      const nIdx = anchor.length >= 3 ? nm.norm.indexOf(anchor) : -1;
      idx = nIdx === -1 ? -1 : nm.map[nIdx];
    }
    if (idx === -1 || idx <= lastStart) {
      passNotes.push(`Could not anchor section “${section.title}” — folded into its neighbor.`);
      continue;
    }
    starts.push({ title: section.title, role: section.role, structuralNote: section.structuralNote, start: idx });
    lastStart = idx;
  }

  if (starts.length === 0) {
    return [{ title: 'The manuscript', role: 'the whole document', start: 0, end: manuscript.length }];
  }
  starts[0].start = 0; // any preamble belongs to the first section
  return starts.map((s, i) => ({ ...s, end: i + 1 < starts.length ? starts[i + 1].start : manuscript.length }));
}

function planDigest(plan: DocumentPlan): string {
  const sections = plan.sections
    .map((s, i) => `  ${i + 1}. ${s.title} — ${s.role}${s.structuralNote ? ` [structural note: ${s.structuralNote}]` : ''}`)
    .join('\n');
  return `THE DOCUMENT PLAN\nThesis: ${plan.thesis}\nAssessment: ${plan.assessment}\nSections:\n${sections}`;
}

export interface RunEditorPassOptions {
  modelId?: string;
  /** The form of the work (charter v0.3). Undeclared, the Editor names it in the plan. */
  form?: DocumentForm;
  /** The matter the manuscript came from, when it came from one. Every call
   *  below sends the manuscript itself, so the pass is bound to that tier. */
  matterId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: EditorProgress) => void;
}

export async function runEditorPass(manuscript: string, options: RunEditorPassOptions = {}): Promise<EditorPassResult> {
  const { signal, onProgress, form, matterId } = options;
  let modelId = options.modelId ?? DEFAULT_EDITOR_MODEL;
  const passNotes: string[] = [];

  const usage = { inputTokens: 0, outputTokens: 0 };
  const onUsage = (u: { inputTokens: number; outputTokens: number }) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
  };

  // The FIRST model call gets the pen-fallback treatment: if the default
  // pen fails before any edit is made, swap pens and reread rather than
  // dying on the desk. Never on a user abort.
  async function firstCallWithFallback<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (signal?.aborted || modelId !== DEFAULT_EDITOR_MODEL || DEFAULT_EDITOR_MODEL === FALLBACK_EDITOR_MODEL) throw err;
      modelId = FALLBACK_EDITOR_MODEL;
      passNotes.push(`The Editor's usual pen was unavailable (${err instanceof Error ? err.message : String(err)}) — this pass ran on the fallback model.`);
      return run();
    }
  }

  type SectionResult = {
    edits: Array<{ before: string; claim: string; failure: string; mark: CorrectiveMark; authority: string; after: string }>;
    praise: Array<{ quote: string; mark: PraiseMark; note: string }>;
  };

  let plan: DocumentPlan;
  const rawEdits: RawEdit[] = [];
  const praise: PraiseNote[] = [];

  if (manuscript.length <= LIGHT_PASS_LIMIT) {
    // The light pass: one sitting, one call — the reading and the edits
    // together. Most of a pass's cost is per-call thinking; a short
    // manuscript doesn't need a separate plan and section apparatus.
    onProgress?.({ phase: 'plan', label: 'The Editor takes the manuscript in one sitting…' });
    const light = await firstCallWithFallback(() =>
      generateStructured<{ thesis: string; assessment: string } & SectionResult>({
        modelId,
        signal,
        matterId,
        onUsage,
        system: lightEditorSystem(form),
        userContent: `THE MANUSCRIPT\n\n${manuscript}`,
        toolName: 'file_edited_manuscript',
        toolDescription: 'File the reading (thesis, assessment) and every proposed edit and praise note, each with its full work-product.',
        inputSchema: LIGHT_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 16000,
      }),
    );
    plan = { thesis: light.thesis, assessment: light.assessment, sections: [] };
    light.edits.forEach((edit, j) => rawEdits.push({ id: `edit-0-${j}`, ...edit }));
    light.praise.forEach((p, j) => praise.push({ id: `praise-0-${j}`, pos: manuscript.indexOf(p.quote), ...p }));
  } else {
    onProgress?.({ phase: 'plan', label: 'Reading for the argument…' });
    plan = await firstCallWithFallback(() =>
      generateStructured<DocumentPlan>({
        modelId,
        signal,
        matterId,
        onUsage,
        system: plannerSystem(form),
        userContent: `THE MANUSCRIPT\n\n${manuscript}`,
        toolName: 'file_document_plan',
        toolDescription: 'File the document-level plan: thesis, structural assessment, and verbatim section anchors.',
        inputSchema: PLAN_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 3000,
      }),
    );

    const sections = resolveSections(manuscript, plan, passNotes);
    const fullContext = manuscript.length <= FULL_CONTEXT_LIMIT;

    // The sections are independent by design — the plan carries the
    // document context — so a few desks work at once. Wall-clock drops
    // from the sum of the sections to roughly the slowest few.
    const results: Array<SectionResult | null> = new Array(sections.length).fill(null);
    let nextIndex = 0;
    let filed = 0;
    onProgress?.({
      phase: 'edit',
      label: `The editors take their sections — 0 of ${sections.length} filed…`,
      sectionIndex: 0,
      sectionCount: sections.length,
    });

    const workOneDesk = async (): Promise<void> => {
      for (;;) {
        const i = nextIndex++;
        if (i >= sections.length) return;
        const section = sections[i];
        const sectionText = manuscript.slice(section.start, section.end);
        const context = fullContext
          ? `THE FULL MANUSCRIPT (for context — edit only your section)\n\n${manuscript}\n\n---\n\n`
          : 'You are seeing only your section; the plan carries the document context.\n\n';
        const userContent =
          `${planDigest(plan)}\n\n${context}` +
          `YOUR SECTION — ${i + 1} of ${sections.length}: “${section.title}” (${section.role})` +
          `${section.structuralNote ? `\nStructural note from the plan: ${section.structuralNote}` : ''}\n\n${sectionText}`;

        try {
          results[i] = await generateStructured<SectionResult>({
            modelId,
            signal,
            matterId,
            onUsage,
            system: sectionEditorSystem(form),
            userContent,
            toolName: 'file_section_edits',
            toolDescription: 'File the proposed edits and praise for this section, each with its full work-product.',
            inputSchema: SECTION_SCHEMA as unknown as Record<string, unknown>,
            maxTokens: 16000,
          });
        } catch (err) {
          if (signal?.aborted) throw err;
          passNotes.push(`Section ${i + 1} (“${section.title}”) could not be edited: ${err instanceof Error ? err.message : String(err)}`);
        }
        filed++;
        onProgress?.({
          phase: 'edit',
          label: `The editors take their sections — ${filed} of ${sections.length} filed…`,
          sectionIndex: Math.min(filed, sections.length - 1),
          sectionCount: sections.length,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(SECTION_CONCURRENCY, sections.length) }, () => workOneDesk()));

    sections.forEach((section, i) => {
      const result = results[i];
      if (!result) return;
      result.edits.forEach((edit, j) => rawEdits.push({ id: `edit-${i}-${j}`, ...edit }));
      result.praise.forEach((p, j) => {
        let pos = manuscript.indexOf(p.quote, section.start);
        if (pos === -1 || pos >= section.end) pos = manuscript.indexOf(p.quote);
        praise.push({ id: `praise-${i}-${j}`, pos, ...p });
      });
    });
  }

  onProgress?.({ phase: 'verify', label: 'Checking citations, quotations, and numbers…' });
  const { accepted: edits, rejected } = verifyEdits(manuscript, rawEdits);

  let criticReport = '';
  if (edits.length > 0) {
    onProgress?.({ phase: 'critic', label: 'The blind critic reads…' });
    try {
      const clean = applyEdits(manuscript, edits);
      const critic = await generateStructured<{
        report: string;
        flags: Array<{ quote: string; mark: CorrectiveMark; note: string }>;
      }>({
        modelId,
        signal,
        matterId,
        onUsage,
        system: criticSystem(form),
        userContent: `THE TEXT\n\n${clean}`,
        toolName: 'file_critic_report',
        toolDescription: 'File the blind critic’s report and any flags on residual AI-isms.',
        inputSchema: CRITIC_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 6000,
      });

      criticReport = critic.report;
      const strays: string[] = [];
      for (const flag of critic.flags) {
        const normQuote = normalize(flag.quote).trim();
        const target = normQuote.length >= 3 ? edits.find((e) => e.after && normalize(e.after).includes(normQuote)) : undefined;
        if (target) {
          target.criticNote = `${flag.mark} — ${flag.note}`;
        } else {
          strays.push(`“${flag.quote}” — ${flag.mark}: ${flag.note}`);
        }
      }
      if (strays.length > 0) {
        criticReport += `\n\nAlso flagged, outside any proposed edit (the section pass let these stand):\n${strays.map((s) => `• ${s}`).join('\n')}`;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      criticReport = 'The blind critic could not complete its read.';
      passNotes.push(`Blind critic failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    criticReport = 'No edits survived to criticize.';
  }

  const price = findModel(modelId)?.model.pricePerM;
  return {
    plan,
    edits,
    praise,
    rejected,
    criticReport,
    passNotes,
    usage: {
      ...usage,
      modelId,
      estimatedCost: price ? (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1e6 : undefined,
    },
  };
}
