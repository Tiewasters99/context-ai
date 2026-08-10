// Server-side PowerPoint (.pptx) renderer for create_deck. Pure: a deck
// spec in, a Buffer out. pptxgenjs is imported lazily so retrieval-only
// callers of mcp-core never pay for it.
//
// The caller (an LLM or the Workbench deck composer) authors the CONTENT;
// this module owns the LOOK: 16:9 white slides, dark ink, a single accent
// (ContextSpaces gold by default), and native editable charts wearing the
// same fixed-order categorical palette as chart-svg.mjs.

import { CHART_COLORS, validateChartSpec } from './chart-svg.mjs';

const ACCENT_DEFAULT = 'E8B84A'; // ContextSpaces gold
const INK = '0B0B0B';
const INK_2 = '52514E';
const MUTED = '898781';
const GRID = 'E1E0D9';
const FONT = 'Segoe UI';

const MAX_SLIDES = 40;

export function validateDeckSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('deck: spec object required');
  if (!spec.title || typeof spec.title !== 'string') throw new Error('deck: title is required');
  if (!Array.isArray(spec.slides) || spec.slides.length === 0) {
    throw new Error('deck: slides (non-empty array) is required');
  }
  if (spec.slides.length > MAX_SLIDES) {
    throw new Error(`deck: at most ${MAX_SLIDES} slides`);
  }
  spec.slides.forEach((s, i) => {
    const n = i + 1;
    if (!s || typeof s !== 'object') throw new Error(`deck: slide ${n} must be an object`);
    if (!s.bullets && !s.table && !s.chart && !s.title) {
      throw new Error(`deck: slide ${n} needs at least a title, bullets, table, or chart`);
    }
    if (s.bullets && !Array.isArray(s.bullets)) {
      throw new Error(`deck: slide ${n}: bullets must be an array of strings or {text, indent}`);
    }
    if (s.table) {
      if (!Array.isArray(s.table.headers) || !Array.isArray(s.table.rows)) {
        throw new Error(`deck: slide ${n}: table needs {headers: string[], rows: string[][]}`);
      }
      for (const r of s.table.rows) {
        if (!Array.isArray(r) || r.length !== s.table.headers.length) {
          throw new Error(`deck: slide ${n}: every table row needs ${s.table.headers.length} cells`);
        }
      }
    }
    if (s.chart) validateChartSpec(s.chart);
  });
  return spec;
}

export async function renderDeck(spec) {
  validateDeckSpec(spec);
  const { default: Pptxgen } = await import('pptxgenjs');
  const accent = /^[0-9a-f]{6}$/i.test(spec.accent ?? '') ? spec.accent.toUpperCase() : ACCENT_DEFAULT;

  const pres = new Pptxgen();
  pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pres.title = spec.title;

  // Cover slide.
  {
    const s = pres.addSlide();
    s.background = { color: 'FFFFFF' };
    s.addShape('rect', { x: 0.6, y: 3.62, w: 1.6, h: 0.08, fill: { color: accent } });
    s.addText(spec.title, {
      x: 0.6, y: 2.4, w: 12.1, h: 1.2,
      fontFace: FONT, fontSize: 40, bold: true, color: INK, align: 'left',
    });
    if (spec.subtitle) {
      s.addText(spec.subtitle, {
        x: 0.6, y: 3.85, w: 12.1, h: 0.7,
        fontFace: FONT, fontSize: 18, color: INK_2, align: 'left',
      });
    }
  }

  for (const slideSpec of spec.slides) {
    const s = pres.addSlide();
    s.background = { color: 'FFFFFF' };
    let y = 0.5;
    if (slideSpec.title) {
      s.addText(slideSpec.title, {
        x: 0.6, y, w: 12.1, h: 0.7,
        fontFace: FONT, fontSize: 26, bold: true, color: INK,
      });
      s.addShape('rect', { x: 0.62, y: y + 0.78, w: 1.1, h: 0.05, fill: { color: accent } });
      y += 1.1;
    }

    const hasChart = !!slideSpec.chart;
    const hasTable = !!slideSpec.table;
    const bullets = slideSpec.bullets ?? [];
    // Bullets share the slide with a chart/table by taking the left column.
    const bulletW = hasChart || hasTable ? 4.6 : 12.1;

    if (bullets.length) {
      const runs = bullets.map((b) => {
        const text = typeof b === 'string' ? b : String(b?.text ?? '');
        const indent = typeof b === 'object' && b ? Math.min(4, Math.max(0, b.indent ?? 0)) : 0;
        return {
          text,
          options: {
            bullet: { code: '2022', indent: 12 },
            indentLevel: indent,
            fontFace: FONT,
            fontSize: indent > 0 ? 14 : 16,
            color: indent > 0 ? INK_2 : INK,
            paraSpaceAfter: 8,
          },
        };
      });
      s.addText(runs, { x: 0.6, y, w: bulletW, h: 6.9 - y, valign: 'top' });
    }

    const rightX = bullets.length ? 5.5 : 0.6;
    const rightW = bullets.length ? 7.2 : 12.1;

    if (hasTable) {
      const { headers, rows } = slideSpec.table;
      s.addTable(
        [
          headers.map((h) => ({
            text: String(h),
            options: { bold: true, color: INK, fill: { color: 'F3F4F6' }, fontFace: FONT, fontSize: 13 },
          })),
          ...rows.map((r) => r.map((c) => ({
            text: String(c),
            options: { color: INK_2, fontFace: FONT, fontSize: 12 },
          }))),
        ],
        {
          x: rightX, y, w: rightW,
          border: { type: 'solid', color: GRID, pt: 0.75 },
          autoPage: false,
        },
      );
    } else if (hasChart) {
      const c = slideSpec.chart;
      const single = c.series.length === 1;
      const isPie = c.type === 'pie' || c.type === 'doughnut';
      const sparse = c.categories.length * c.series.length <= 14;
      const data = c.series.map((ser) => ({
        name: ser.name,
        labels: c.categories,
        values: ser.values,
      }));
      s.addChart(c.type, data, {
        x: rightX, y, w: rightW, h: 6.8 - y,
        chartColors: (isPie ? c.categories : c.series).map((_, i) => CHART_COLORS[i % CHART_COLORS.length].replace('#', '').toUpperCase()),
        showTitle: !!c.title,
        title: c.title ?? '',
        titleFontFace: FONT, titleFontSize: 14, titleColor: INK,
        // Legend for >= 2 series; a single series is named by the title.
        showLegend: isPie || !single,
        legendPos: 'b', legendFontFace: FONT, legendFontSize: 11, legendColor: INK_2,
        showValue: !isPie && sparse,
        showPercent: isPie,
        dataLabelFontFace: FONT, dataLabelFontSize: 10, dataLabelColor: INK_2,
        catAxisLabelFontFace: FONT, catAxisLabelFontSize: 11, catAxisLabelColor: MUTED,
        valAxisLabelFontFace: FONT, valAxisLabelFontSize: 11, valAxisLabelColor: MUTED,
        valGridLine: { style: 'solid', color: GRID, size: 0.75 },
        catGridLine: { style: 'none' },
        lineSize: 2.5,
        lineDataSymbol: 'none',
        barGapWidthPct: 40,
        holeSize: c.type === 'doughnut' ? 55 : undefined,
      });
    }

    if (slideSpec.notes) s.addNotes(String(slideSpec.notes));
  }

  const b64 = await pres.write({ outputType: 'base64' });
  return Buffer.from(b64, 'base64');
}
