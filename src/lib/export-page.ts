// Page → .docx export.
//
// Walks a TipTap (ProseMirror) JSON document and emits a docx Blob using the
// `docx` package. Covers the node and mark types StarterKit + Link ship with,
// since that's the editor configured in src/components/content/Editor.tsx.

import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: Mark[];
  text?: string;
  content?: Node[];
};

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

function runsFromInline(nodes: Node[] | undefined): (TextRun | ExternalHyperlink)[] {
  if (!nodes) return [];
  const out: (TextRun | ExternalHyperlink)[] = [];
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      out.push(new TextRun({ break: 1 }));
      continue;
    }
    if (node.type !== 'text' || !node.text) continue;
    const marks = node.marks ?? [];
    const link = marks.find((m) => m.type === 'link');
    const bold = marks.some((m) => m.type === 'bold');
    const italic = marks.some((m) => m.type === 'italic');
    const strike = marks.some((m) => m.type === 'strike');
    const code = marks.some((m) => m.type === 'code');
    const run = new TextRun({
      text: node.text,
      bold,
      italics: italic,
      strike,
      font: code ? { name: 'Consolas' } : undefined,
      style: link ? 'Hyperlink' : undefined,
    });
    if (link && typeof link.attrs?.href === 'string') {
      out.push(new ExternalHyperlink({ children: [run], link: link.attrs.href }));
    } else {
      out.push(run);
    }
  }
  return out;
}

function blocksFromNode(
  node: Node,
  ctx: { listLevel: number; listKind: 'bullet' | 'number' | null },
): Paragraph[] {
  switch (node.type) {
    case 'paragraph':
      return [new Paragraph({ children: runsFromInline(node.content) })];

    case 'heading': {
      const level = Number(node.attrs?.level) || 1;
      return [
        new Paragraph({
          heading: HEADING_LEVELS[level] ?? HeadingLevel.HEADING_2,
          children: runsFromInline(node.content),
        }),
      ];
    }

    case 'blockquote': {
      const inner = (node.content ?? []).flatMap((c) => blocksFromNode(c, ctx));
      return inner.map(
        (p) =>
          new Paragraph({
            children: (p as unknown as { options: { children: TextRun[] } }).options.children,
            indent: { left: 720 },
            border: {
              left: { color: '888888', size: 12, style: 'single', space: 12 },
            },
          }),
      );
    }

    case 'codeBlock':
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: (node.content ?? []).map((c) => c.text ?? '').join(''),
              font: { name: 'Consolas' },
            }),
          ],
          shading: { type: 'clear', fill: 'F2F2F2', color: 'auto' },
        }),
      ];

    case 'bulletList':
    case 'orderedList': {
      const kind = node.type === 'bulletList' ? 'bullet' : 'number';
      return (node.content ?? []).flatMap((li) =>
        blocksFromNode(li, { listLevel: ctx.listLevel + 1, listKind: kind }),
      );
    }

    case 'listItem': {
      const kind = ctx.listKind ?? 'bullet';
      const level = Math.max(0, ctx.listLevel - 1);
      return (node.content ?? []).flatMap((child, i) => {
        if (child.type === 'paragraph') {
          return [
            new Paragraph({
              children: runsFromInline(child.content),
              bullet: kind === 'bullet' ? { level } : undefined,
              numbering:
                kind === 'number'
                  ? { reference: 'cs-numbered', level }
                  : undefined,
            }),
          ];
        }
        return blocksFromNode(child, {
          listLevel: ctx.listLevel + (i === 0 ? 0 : 1),
          listKind: ctx.listKind,
        });
      });
    }

    case 'horizontalRule':
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun('— — —')],
        }),
      ];

    default:
      return (node.content ?? []).flatMap((c) => blocksFromNode(c, ctx));
  }
}

export async function pageToDocxBlob(
  body: unknown,
  title: string,
): Promise<Blob> {
  const root = (body && typeof body === 'object' ? (body as Node) : { type: 'doc' });
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: title || 'Untitled Page' })],
    }),
    ...(root.content ?? []).flatMap((n) =>
      blocksFromNode(n, { listLevel: 0, listKind: null }),
    ),
  ];

  const doc = new Document({
    creator: 'Contextspaces',
    title: title || 'Untitled Page',
    numbering: {
      config: [
        {
          reference: 'cs-numbered',
          levels: [0, 1, 2, 3, 4].map((lvl) => ({
            level: lvl,
            format: 'decimal',
            text: `%${lvl + 1}.`,
            alignment: AlignmentType.START,
          })),
        },
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBlob(doc);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(title: string, ext: string): string {
  const base = (title || 'page').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'page';
  return `${base}${ext}`;
}
