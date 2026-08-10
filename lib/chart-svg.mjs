// Server-side SVG chart renderer for the Sandbox document tasks
// (create_chart, and the spec-validation shared with create_deck's native
// pptx charts). Pure: spec in, SVG string out — no DOM, no deps.
//
// Style follows the platform data-viz method (validated 2026-08-09 against
// a white surface): fixed-order categorical palette (never cycled), one
// axis, recessive grid, thin marks with surface gaps, legend for >= 2
// series, and direct value labels on sparse charts — the "relief" that
// keeps the low-contrast hues (aqua/yellow/magenta) legible.

// Categorical slots, fixed order — the ordering is the CVD-safety
// mechanism (adjacent-pair validated), so never re-sort or cycle it.
export const CHART_COLORS = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
  '#e87ba4', '#008300', '#4a3aa7', '#e34948',
];

const INK = '#0b0b0b';        // titles
const INK_2 = '#52514e';      // legend, value labels
const MUTED = '#898781';      // axis tick labels
const GRID = '#e1e0d9';       // hairline gridlines
const BASELINE = '#c3c2b7';   // axis baseline
const SURFACE = '#ffffff';
const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';

const W = 960;
const H = 540;

export const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut'];

// Shared by create_chart and create_deck chart slides. Throws with
// LLM-actionable messages.
export function validateChartSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('chart: spec object required');
  if (!CHART_TYPES.includes(spec.type)) {
    throw new Error(`chart: type must be one of ${CHART_TYPES.join(', ')}`);
  }
  const cats = spec.categories;
  if (!Array.isArray(cats) || cats.length === 0) {
    throw new Error('chart: categories (array of labels) is required');
  }
  const series = spec.series;
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error('chart: series (array of {name, values}) is required');
  }
  if (series.length > CHART_COLORS.length) {
    throw new Error(
      `chart: at most ${CHART_COLORS.length} series — fold the smallest into "Other"`
    );
  }
  for (const s of series) {
    if (!s || typeof s.name !== 'string' || !Array.isArray(s.values)) {
      throw new Error('chart: each series needs {name: string, values: number[]}');
    }
    if (s.values.length !== cats.length) {
      throw new Error(
        `chart: series "${s.name}" has ${s.values.length} values but there are ${cats.length} categories`
      );
    }
    if (s.values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error(`chart: series "${s.name}" contains a non-numeric value`);
    }
  }
  if ((spec.type === 'pie' || spec.type === 'doughnut')) {
    if (series.length > 1) {
      throw new Error('chart: pie/doughnut takes exactly 1 series (one value per category)');
    }
    if (cats.length > 8) {
      throw new Error('chart: pie/doughnut supports at most 8 slices — fold the smallest into "Other"');
    }
    if (series[0].values.some((v) => v < 0)) {
      throw new Error('chart: pie/doughnut values must be non-negative');
    }
  }
  return spec;
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function fmt(n) {
  const abs = Math.abs(n);
  const r = abs >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return r.toLocaleString('en-US');
}

// Standard nice-number ticks: ~5 steps of 1/2/2.5/5 x 10^k, zero included.
function niceTicks(min, max) {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  const span = hi - lo || 1;
  const rawStep = span / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1e9) / 1e9);
  return ticks;
}

function legendRow(series, x, y) {
  let out = '';
  let cx = x;
  series.forEach((s, i) => {
    out += `<rect x="${cx}" y="${y - 9}" width="10" height="10" rx="3" fill="${CHART_COLORS[i]}"/>`;
    out += `<text x="${cx + 15}" y="${y}" font-family="${FONT}" font-size="12" fill="${INK_2}">${esc(s.name)}</text>`;
    cx += 15 + 7 * String(s.name).length + 26;
  });
  return out;
}

export function renderChartSvg(spec) {
  validateChartSpec(spec);
  const { type, title, categories, series } = spec;
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${SURFACE}"/>`
  );
  let top = 34;
  if (title) {
    parts.push(`<text x="40" y="${top}" font-family="${FONT}" font-size="20" font-weight="600" fill="${INK}">${esc(title)}</text>`);
    top += 14;
  }
  // Legend only when identity needs it — a single series is named by the title.
  if (series.length >= 2 && type !== 'pie' && type !== 'doughnut') {
    parts.push(legendRow(series, 40, top + 16));
    top += 26;
  }

  if (type === 'pie' || type === 'doughnut') {
    parts.push(renderPie(spec, top));
  } else {
    parts.push(renderXY(spec, top));
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function renderXY(spec, top) {
  const { type, categories, series } = spec;
  const mLeft = 72;
  const mRight = 32;
  const mBottom = spec.x_label ? 78 : 56;
  const plotX = mLeft;
  const plotY = top + 18;
  const plotW = W - mLeft - mRight;
  const plotH = H - plotY - mBottom;

  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const vMin = ticks[0];
  const vMax = ticks[ticks.length - 1];
  const yOf = (v) => plotY + plotH - ((v - vMin) / (vMax - vMin || 1)) * plotH;

  const out = [];
  // Recessive horizontal grid + muted tick labels; no vertical grid.
  for (const t of ticks) {
    const y = yOf(t);
    out.push(`<line x1="${plotX}" y1="${y}" x2="${plotX + plotW}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`);
    out.push(`<text x="${plotX - 10}" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${MUTED}">${fmt(t)}</text>`);
  }
  // Baseline at zero (or plot bottom when zero is out of range).
  const zeroY = vMin <= 0 && vMax >= 0 ? yOf(0) : plotY + plotH;
  out.push(`<line x1="${plotX}" y1="${zeroY}" x2="${plotX + plotW}" y2="${zeroY}" stroke="${BASELINE}" stroke-width="1.5"/>`);

  const n = categories.length;
  const slotW = plotW / n;
  const totalMarks = n * series.length;
  const labelMarks = totalMarks <= 14; // relief: direct labels on sparse charts

  if (type === 'bar') {
    const gap = 2; // surface gap between adjacent bars
    const groupPad = Math.max(8, slotW * 0.18);
    const barW = Math.max(4, (slotW - groupPad * 2 - gap * (series.length - 1)) / series.length);
    categories.forEach((cat, ci) => {
      series.forEach((s, si) => {
        const v = s.values[ci];
        const x = plotX + ci * slotW + groupPad + si * (barW + gap);
        const y0 = yOf(Math.max(0, v));
        const h = Math.abs(yOf(v) - yOf(0));
        const r = Math.min(4, barW / 2, h); // rounded data-end, anchored at baseline
        const yTop = v >= 0 ? y0 : yOf(0);
        const path = v >= 0
          ? `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`
          : `M${x},${yTop} V${yTop + h - r} Q${x},${yTop + h} ${x + r},${yTop + h} H${x + barW - r} Q${x + barW},${yTop + h} ${x + barW},${yTop + h - r} V${yTop} Z`;
        out.push(`<path d="${path}" fill="${CHART_COLORS[si]}"/>`);
        if (labelMarks) {
          const ly = v >= 0 ? yTop - 6 : yTop + h + 14;
          out.push(`<text x="${x + barW / 2}" y="${ly}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${INK_2}">${fmt(v)}</text>`);
        }
      });
    });
  } else { // line
    series.forEach((s, si) => {
      const pts = s.values.map((v, ci) => [plotX + ci * slotW + slotW / 2, yOf(v)]);
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      out.push(`<path d="${d}" fill="none" stroke="${CHART_COLORS[si]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
      // Endpoint dot + direct series label at the line's end (<= 4 series).
      const last = pts[pts.length - 1];
      out.push(`<circle cx="${last[0]}" cy="${last[1]}" r="4" fill="${CHART_COLORS[si]}" stroke="${SURFACE}" stroke-width="2"/>`);
      if (series.length <= 4) {
        out.push(`<text x="${Math.min(last[0] + 8, W - 4)}" y="${last[1] + 4}" font-family="${FONT}" font-size="12" fill="${INK_2}">${esc(s.name)}</text>`);
      }
      if (labelMarks) {
        pts.forEach((p, ci) => {
          if (ci === pts.length - 1) return;
          out.push(`<text x="${p[0]}" y="${p[1] - 9}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${INK_2}">${fmt(s.values[ci])}</text>`);
        });
      }
    });
  }

  // Category labels, muted; thin diagonal fallback when crowded.
  const rotate = n > 8 || categories.some((c) => String(c).length > 12);
  categories.forEach((cat, ci) => {
    const x = plotX + ci * slotW + slotW / 2;
    const y = plotY + plotH + 20;
    out.push(rotate
      ? `<text x="${x}" y="${y}" text-anchor="end" transform="rotate(-30 ${x} ${y})" font-family="${FONT}" font-size="11" fill="${MUTED}">${esc(cat)}</text>`
      : `<text x="${x}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${MUTED}">${esc(cat)}</text>`);
  });
  if (spec.x_label) {
    out.push(`<text x="${plotX + plotW / 2}" y="${H - 14}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${INK_2}">${esc(spec.x_label)}</text>`);
  }
  if (spec.y_label) {
    out.push(`<text x="18" y="${plotY + plotH / 2}" text-anchor="middle" transform="rotate(-90 18 ${plotY + plotH / 2})" font-family="${FONT}" font-size="12" fill="${INK_2}">${esc(spec.y_label)}</text>`);
  }
  return out.join('\n');
}

function renderPie(spec, top) {
  const { type, categories, series } = spec;
  const values = series[0].values;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = W * 0.36;
  const cy = top + (H - top) / 2;
  const R = Math.min(W * 0.26, (H - top) / 2 - 30);
  const rInner = type === 'doughnut' ? R * 0.55 : 0;

  const out = [];
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    const frac = v / total;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    if (frac <= 0) return;
    const large = frac > 0.5 ? 1 : 0;
    const p0 = [cx + R * Math.cos(a0), cy + R * Math.sin(a0)];
    const p1 = [cx + R * Math.cos(a1), cy + R * Math.sin(a1)];
    let d;
    if (rInner > 0) {
      const q0 = [cx + rInner * Math.cos(a1), cy + rInner * Math.sin(a1)];
      const q1 = [cx + rInner * Math.cos(a0), cy + rInner * Math.sin(a0)];
      d = `M${p0[0]},${p0[1]} A${R},${R} 0 ${large} 1 ${p1[0]},${p1[1]} L${q0[0]},${q0[1]} A${rInner},${rInner} 0 ${large} 0 ${q1[0]},${q1[1]} Z`;
    } else {
      d = `M${cx},${cy} L${p0[0]},${p0[1]} A${R},${R} 0 ${large} 1 ${p1[0]},${p1[1]} Z`;
    }
    // 2px surface stroke = the spacer between adjacent fills.
    out.push(`<path d="${d}" fill="${CHART_COLORS[i]}" stroke="${SURFACE}" stroke-width="2"/>`);
    // Direct percent labels on slices big enough to hold them.
    if (frac >= 0.06) {
      const mid = (a0 + a1) / 2;
      const lr = rInner > 0 ? (R + rInner) / 2 : R * 0.62;
      const lx = cx + lr * Math.cos(mid);
      const ly = cy + lr * Math.sin(mid);
      out.push(`<text x="${lx}" y="${ly + 4}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="${SURFACE}">${Math.round(frac * 100)}%</text>`);
    }
  });

  // Right-hand legend column: swatch, name, value (identity never color-alone).
  const lx = W * 0.66;
  let ly = cy - (categories.length * 26) / 2 + 8;
  categories.forEach((cat, i) => {
    out.push(`<rect x="${lx}" y="${ly - 10}" width="10" height="10" rx="3" fill="${CHART_COLORS[i]}"/>`);
    out.push(`<text x="${lx + 16}" y="${ly}" font-family="${FONT}" font-size="13" fill="${INK_2}">${esc(cat)}</text>`);
    out.push(`<text x="${lx + 16 + Math.min(220, 8 * String(cat).length) + 14}" y="${ly}" font-family="${FONT}" font-size="13" fill="${MUTED}">${fmt(values[i])}</text>`);
    ly += 26;
  });
  return out.join('\n');
}
