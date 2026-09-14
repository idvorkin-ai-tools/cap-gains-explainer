// Swept comparison charts — zero dependencies, plain <canvas>.
//
// The page's point readouts answer "what does THIS sale cost?". These charts
// answer "what does the whole curve look like?" — which is the only way to see
// that the timing penalty is a cliff rather than a slope.
//
// Reads tax.js; never modifies it. All y-values come from calc().

import { calc } from "./tax.js";

/* ────────────────────────── pure helpers (no DOM — unit-tested) ───────────── */

/** Ticks from 0 to exactly `max`, inclusive. Callers pass an axisMax'd max, so
 *  we pick the divisor that keeps the step readable rather than picking a step
 *  and letting the top gridline fall short of the axis. */
const NICE_MANTISSAS = [1, 1.25, 2, 2.5, 5];
function isNiceStep(v) {
  if (!(v > 0) || !Number.isFinite(v)) return false;
  const m = v / Math.pow(10, Math.floor(Math.log10(v)));
  return NICE_MANTISSAS.some(x => Math.abs(m - x) < 1e-9);
}
export function niceTicks(max, count = 4) {
  if (!(max > 0) || !Number.isFinite(max)) return [0];
  let n = count;
  for (const cand of [count, count + 1, count - 1, 2]) {
    if (cand >= 2 && isNiceStep(max / cand)) { n = cand; break; }
  }
  const out = [];
  for (let i = 0; i <= n; i++) out.push(Math.round(((max * i) / n) * 1e6) / 1e6);
  return out;
}

/** Stable, snapped x-domain for the gains sweep: only changes at a few
 *  thresholds, so the axis doesn't jitter while you drag a slider. */
export const SWEEP_STEPS = [500e3, 750e3, 1e6, 1.5e6, 2e6, 3e6, 5e6];
export function sweepDomain(total) {
  const want = Math.max(0, total) * 1.35;
  return SWEEP_STEPS.find(s => s >= want) ?? SWEEP_STEPS[SWEEP_STEPS.length - 1];
}

/** Sample fn across [x0,x1]. `breaks` are hints only — they sharpen corners by
 *  landing a sample exactly on a kink. Y always comes from fn, so a wrong hint
 *  costs sharpness, never correctness. */
export function sampleCurve(fn, x0, x1, n = 320, breaks = []) {
  const xs = [];
  for (let i = 0; i <= n; i++) xs.push(x0 + ((x1 - x0) * i) / n);
  for (const b of breaks) if (Number.isFinite(b) && b > x0 && b < x1) xs.push(b);
  xs.sort((a, b) => a - b);
  return xs.map(x => ({ x, y: fn(x) }));
}

/** Gains-space kinks at a given level of ordinary income: where the deduction
 *  runs out, where the federal 0%/15%/20% boundaries land, NIIT onset, and the
 *  two WA thresholds. `ord` is the whole ordinary pool — wages plus interest —
 *  because calc() stacks gains above that pool and doesn't care which is which. */
export function gainsBreaks(ord, k) {
  const dedn = Math.max(0, k.stdded);
  const ordTaxable = Math.max(0, ord - dedn);
  const dednLeft = Math.max(0, dedn - ord);
  return [
    dednLeft,
    dednLeft + Math.max(0, k.ltcg0 - ordTaxable),
    dednLeft + Math.max(0, k.ltcg15 - ordTaxable),
    k.niit - ord,
    k.waExempt,
    k.waExempt + 1_000_000,
  ];
}

/** Wage-space kinks for the penalty-vs-wages sweep. `other` (interest) already
 *  occupies that much of the ordinary pool, so every kink arrives that many
 *  dollars of wages earlier; ones that fall below $0 are simply off the left of
 *  the domain, and sampleCurve drops them. */
export function wageBreaks(k, other = 0) {
  const d = Math.max(0, k.stdded);
  return [d, d + Math.max(0, k.ltcg0), k.niit].map(x => x - other);
}

/** x where a curve first lifts off zero — the foot of the cliff. null if flat. */
export function firstRise(points, eps = 0.5) {
  const p = points.find(q => q.y > eps);
  return p ? p.x : null;
}

/** Axis maximum: a little headroom over the peak so a saturating curve doesn't
 *  sit welded to the top gridline, snapped to a round number. Finer ladder than
 *  niceCeil, because "round up 5,000 to 10,000" wastes half the plot. */
const AXIS_LADDER = [1, 1.2, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10];
export function axisMax(peak, pad = 1.06) {
  if (!(peak > 0) || !Number.isFinite(peak)) return 1;
  const v = peak * pad;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  return (AXIS_LADDER.find(x => m <= x + 1e-9) ?? 10) * e;
}

/** Compact axis money. Below $10K it stays exact — rounding 2,500 to "$3K"
 *  on a $5,000 axis is a lie the reader can't detect. */
const trimZeros = n => n.toFixed(2).replace(/\.?0+$/, "");
export function axisMoney(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return "$" + trimZeros(v / 1e6) + "M";
  if (a >= 1e4) return "$" + trimZeros(v / 1e3) + "K";
  return "$" + Math.round(v).toLocaleString();
}

const fullMoney = n => (n < 0 ? "−$" : "$") + Math.round(Math.abs(n)).toLocaleString();

/* ────────────────────────── canvas rendering (browser) ────────────────────── */

const PAD = { l: 54, r: 14, t: 16, b: 26 };

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim() || "#888";
  return {
    ink: g("--ink"), muted: g("--muted"), rule: g("--rule"),
    raise: g("--raise"), accent: g("--accent"), bad: g("--bad"),
  };
}

function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(2, canvas.clientWidth || 0);
  const h = Math.round(Math.max(190, Math.min(300, w * 0.52)));
  canvas.style.height = h + "px";
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * spec = {
 *   xMax, yMax, series:[{points,color,dash,label}], band:bool,
 *   markers:[{x,label,strong}], xFmt, yFmt, hoverFmt(x)->[[k,v,color?]],
 *   note: string|null
 * }
 */
function draw(canvas, spec, hoverX) {
  const { ctx, w, h } = fit(canvas);
  if (w < 60) return;
  const t = tokens();
  const L = PAD.l, R = w - PAD.r, T = PAD.t, B = h - PAD.b;
  const pw = R - L, ph = B - T;
  if (pw < 20 || ph < 20) return;

  const sx = v => L + (v / spec.xMax) * pw;
  const sy = v => B - (v / spec.yMax) * ph;

  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = "middle";

  // ── grid + y labels (recessive)
  ctx.strokeStyle = t.rule;
  ctx.lineWidth = 1;
  ctx.fillStyle = t.muted;
  ctx.textAlign = "right";
  for (const v of niceTicks(spec.yMax, 4)) {
    const y = Math.round(sy(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    ctx.fillText(spec.yFmt(v), L - 8, sy(v));
  }
  // ── x labels; the end ticks hug their edge so they can't overflow the canvas
  for (const v of niceTicks(spec.xMax, 4)) {
    if (v > spec.xMax) continue;
    ctx.textAlign = v === 0 ? "left" : Math.abs(v - spec.xMax) < 1e-6 ? "right" : "center";
    ctx.fillText(spec.xFmt(v), sx(v), B + 13);
  }

  const clip = () => { ctx.save(); ctx.beginPath(); ctx.rect(L, T - 4, pw, ph + 8); ctx.clip(); };

  // ── band between the two curves = the timing penalty
  if (spec.band && spec.series.length === 2) {
    const [a, b] = spec.series;      // a = lower (no wages), b = upper (working)
    clip();
    ctx.beginPath();
    b.points.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
    for (let i = a.points.length - 1; i >= 0; i--) ctx.lineTo(sx(a.points[i].x), sy(a.points[i].y));
    ctx.closePath();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = b.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── area under a lone series reads as magnitude
  if (spec.fillUnder && spec.series.length === 1) {
    const s = spec.series[0];
    clip();
    ctx.beginPath();
    s.points.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
    ctx.lineTo(sx(s.points[s.points.length - 1].x), B);
    ctx.lineTo(sx(s.points[0].x), B);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── vertical markers (current slider positions)
  for (const m of spec.markers || []) {
    if (!(m.x >= 0 && m.x <= spec.xMax)) continue;
    const x = Math.round(sx(m.x)) + 0.5;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = t.muted;
    ctx.globalAlpha = m.strong ? 0.85 : 0.4;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
    ctx.restore();
    if (m.label) {
      ctx.fillStyle = t.muted;
      ctx.textAlign = x > R - 40 ? "right" : "left";
      ctx.fillText(m.label, x > R - 40 ? x - 4 : x + 4, T + 5);
    }
  }

  // ── curves (2px, dashed on the working-year series for non-colour identity)
  clip();
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const s of spec.series) {
    ctx.save();
    if (s.dash) ctx.setLineDash(s.dash);
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    s.points.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // ── dots at the current position, with a surface ring so they read on any fill
  const dotAt = spec.markers?.find(m => m.strong);
  if (dotAt) {
    for (const s of spec.series) {
      const p = nearest(s.points, dotAt.x);
      if (!p || p.x > spec.xMax) continue;
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = t.raise;
      ctx.stroke();
    }
  }

  // ── direct labels: a colour chip carries identity, the text stays in ink.
  // Clearance is measured across the label's whole x-span, not just its anchor,
  // or a steeply rising curve walks straight through its own name.
  if (spec.series.length === 2 && spec.labelAt != null) {
    for (const s of spec.series) {
      const p = nearest(s.points, spec.labelAt);
      if (!p) continue;
      const tw = ctx.measureText(s.label).width;
      const x = sx(p.x);
      const flip = x + tw + 12 > R;            // no room to the right — label leftwards
      const x0 = flip ? x - tw - 12 : x - 2;
      const x1 = flip ? x + 6 : x + tw + 8;

      const ys = s.points.filter(q => sx(q.x) >= x0 && sx(q.x) <= x1).map(q => sy(q.y));
      if (!ys.length) ys.push(sy(p.y));
      const y = s.above
        ? Math.max(T + 6, Math.min(...ys) - 10)
        : Math.min(B - 6, Math.max(...ys) + 13);

      ctx.beginPath();
      ctx.arc(flip ? x + 3 : x - 5, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.fillStyle = t.muted;
      ctx.textAlign = flip ? "right" : "left";
      ctx.fillText(s.label, flip ? x - 5 : x + 3, y);
    }
  }

  // ── the gap, named where it is widest on screen
  if (spec.gapLabel && spec.series.length === 2) {
    const g = spec.gapLabel;
    const x = sx(g.x);
    const y = (sy(g.lo) + sy(g.hi)) / 2;
    if (Math.abs(sy(g.lo) - sy(g.hi)) > 14) {
      ctx.fillStyle = spec.series[1].color;
      ctx.textAlign = x > R - 70 ? "right" : "left";
      ctx.fillText(g.text, x > R - 70 ? x - 7 : x + 7, y);
    }
  }

  // ── hover crosshair + tooltip
  if (hoverX != null) {
    const x = Math.round(sx(hoverX)) + 0.5;
    ctx.save();
    ctx.strokeStyle = t.muted;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
    ctx.restore();
    for (const s of spec.series) {
      const p = nearest(s.points, hoverX);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = t.raise;
      ctx.stroke();
    }
    tooltip(ctx, t, spec.hoverFmt(hoverX), x, T, L, R, B);
  }

}

function nearest(points, x) {
  if (!points.length) return null;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x < x) lo = mid; else hi = mid;
  }
  return Math.abs(points[lo].x - x) <= Math.abs(points[hi].x - x) ? points[lo] : points[hi];
}

function tooltip(ctx, t, rows, x, T, L, R, B) {
  if (!rows || !rows.length) return;
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const lh = 15, padX = 8, padY = 6;
  const wBox = Math.max(...rows.map(r => ctx.measureText(r[0] + "  " + r[1]).width)) + padX * 2;
  const hBox = rows.length * lh + padY * 2;
  let bx = x + 10;
  if (bx + wBox > R) bx = x - 10 - wBox;
  bx = Math.max(L, Math.min(bx, R - wBox));
  const by = Math.min(T + 6, B - hBox);

  ctx.save();
  ctx.globalAlpha = 0.97;
  ctx.fillStyle = t.raise;
  roundRect(ctx, bx, by, wBox, hBox, 4);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = t.rule;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  rows.forEach((r, i) => {
    const y = by + padY + lh * i + lh / 2;
    ctx.textAlign = "left";
    ctx.fillStyle = t.muted;
    ctx.fillText(r[0], bx + padX, y);
    ctx.textAlign = "right";
    ctx.fillStyle = r[2] || t.ink;
    ctx.fillText(r[1], bx + wBox - padX, y);
  });
}

/** Wire a canvas: handles DPR, resize, theme flips, and pointer hover.
 *  Takes a *builder*, not a spec, so a theme change re-resolves the CSS tokens
 *  instead of redrawing with the colours of the theme we just left. The built
 *  spec is cached, so hover and resize don't re-run the sweep. */
export function createChart(canvas) {
  let build = null, spec = null, hoverX = null;
  const redraw = () => {
    if (!build) return;
    if (!spec) spec = build();
    if (canvas.getAttribute("aria-label") !== spec.aria && spec.aria)
      canvas.setAttribute("aria-label", spec.aria);
    draw(canvas, spec, hoverX);
  };
  const rebuild = () => { spec = null; redraw(); };

  const onMove = ev => {
    if (!spec) return;
    const r = canvas.getBoundingClientRect();
    const L = PAD.l, R = r.width - PAD.r;
    const px = ev.clientX - r.left;
    if (px < L - 6 || px > R + 6) return;
    hoverX = Math.max(0, Math.min(spec.xMax, ((px - L) / Math.max(1, R - L)) * spec.xMax));
    redraw();
  };
  const clear = () => { if (hoverX != null) { hoverX = null; redraw(); } };

  // No preventDefault: `touch-action: pan-y` in the CSS already reserves
  // vertical panning for the page, so scrubbing never traps the scroll.
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onMove);
  canvas.addEventListener("pointerleave", clear);
  canvas.addEventListener("pointercancel", clear);
  canvas.addEventListener("pointerup", clear);

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(redraw).observe(canvas);
  else window.addEventListener("resize", redraw);

  // theme can change under us two ways: the OS setting, or [data-theme]
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", rebuild);
  new MutationObserver(rebuild).observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-theme"],
  });

  return { update(builder) { build = builder; rebuild(); } };
}

/* ────────────────────────── the two chart specs ───────────────────────────── */

/** Sweep gains along x; compare total capital-gains tax with and without wages.
 *  `other` is interest — ordinary income that doesn't retire — so it sits under
 *  the gains in BOTH curves and the only difference between them is the wages.
 *  The band between them is therefore what the wages cost on top of that
 *  interest, which is the same number the page prints above. */
export function gainsSweepSpec(wage, base, extra, K, other, t) {
  const total = base + extra;
  const xMax = sweepDomain(total);
  const work = sampleCurve(x => calc(wage, x, K, other).total, 0, xMax, 320, gainsBreaks(wage + other, K));
  const none = sampleCurve(x => calc(0, x, K, other).total, 0, xMax, 320, gainsBreaks(other, K));
  const yMax = axisMax(Math.max(work[work.length - 1].y, none[none.length - 1].y, 1));

  const gapAt = x => calc(wage, x, K, other).total - calc(0, x, K, other).total;
  const working = wage > 0;
  // The lower curve is still the no-wage year; with interest in it, "interest
  // only" is both shorter and more honest than calling it an empty year.
  const noneLabel = other > 0 ? "interest only" : "no-wage year";

  const markers = [{ x: total, label: "now", strong: true }];
  if (extra > 0) markers.unshift({ x: base, label: "draw" });

  return {
    xMax, yMax,
    band: working,
    series: working
      ? [
          { points: none, color: t.accent, label: noneLabel, above: false },
          { points: work, color: t.bad, dash: [6, 4], label: "working year", above: true },
        ]
      : [{ points: none, color: t.accent, label: noneLabel }],
    fillUnder: !working,
    markers,
    labelAt: working ? xMax * 0.6 : null,
    gapLabel: working && gapAt(total) > 0
      ? { x: total, lo: calc(0, total, K, other).total, hi: calc(wage, total, K, other).total, text: "+" + fullMoney(gapAt(total)) }
      : null,
    aria: working
      ? `Capital-gains tax as realized gains rise from $0 to ${axisMoney(xMax)}`
        + (other > 0 ? `, with ${fullMoney(other)} of interest in both years` : ``)
        + `. At ${fullMoney(total)} realized, `
        + `a no-wage year costs ${fullMoney(calc(0, total, K, other).total)} and a working year at ${fullMoney(wage)} of wages `
        + `costs ${fullMoney(calc(wage, total, K, other).total)} — a gap of ${fullMoney(gapAt(total))}.`
      : `Capital-gains tax as realized gains rise from $0 to ${axisMoney(xMax)}, with no wages`
        + (other > 0 ? ` but ${fullMoney(other)} of interest` : ``)
        + `. At ${fullMoney(total)} realized it costs ${fullMoney(calc(0, total, K, other).total)}. `
        + `Raise the wages slider to open a gap.`,
    xFmt: axisMoney,
    yFmt: axisMoney,
    hoverFmt: x => {
      const a = calc(0, x, K, other).total, b = calc(wage, x, K, other).total;
      const rows = [["realized", fullMoney(x)], [other > 0 ? "interest only" : "no-wage yr", fullMoney(a), t.accent]];
      if (working) rows.push(["working yr", fullMoney(b), t.bad], ["wages cost", "+" + fullMoney(b - a), t.bad]);
      return rows;
    },
  };
}

/** timingPenalty from tax.js, curried on wages so it can be swept. Identical
 *  arithmetic — the no-wage leg is hoisted because it doesn't vary with w. The
 *  interest `other` is in both legs, so it never registers as a penalty; what it
 *  does is spend the cheap brackets before the wages reach them, which walks the
 *  cliff edge down to a lower wage — and enough of it flattens the penalty away
 *  entirely, because then the no-wage year has no cheap brackets left either. */
export function penaltyFn(base, slice, K, other = 0) {
  const later = calc(0, base + slice, K, other).total - calc(0, base, K, other).total;
  return w => calc(w, base + slice, K, other).total - calc(w, base, K, other).total - later;
}

/** Where the cliff starts and where it tops out, for captions and the axis.
 *  `other` sits before `xMax` because it's part of the model, not the framing. */
export function cliffFacts(base, slice, K, other = 0, xMax = 800_000) {
  const points = sampleCurve(penaltyFn(base, slice, K, other), 0, xMax, 320, wageBreaks(K, other));
  return { foot: firstRise(points), plateau: Math.max(...points.map(p => p.y), 0), points };
}

/** Sweep wages along x; y is the timing penalty on the current extra slice.
 *  This is the chart where the cliff is literally visible. */
export function penaltyCliffSpec(wage, base, slice, K, other, t, preview) {
  const xMax = 800_000;
  const pen = penaltyFn(base, slice, K, other);
  const { foot: rise, plateau: top, points: pts } = cliffFacts(base, slice, K, other, xMax);
  const yMax = axisMax(Math.max(top, 1));

  return {
    xMax, yMax,
    series: [{ points: pts, color: t.bad, dash: preview ? [5, 4] : null, label: "timing penalty" }],
    fillUnder: true,
    band: false,
    markers: [{ x: wage, label: "wages now", strong: true }],
    labelAt: null,
    gapLabel: null,
    aria: `Timing penalty on a ${fullMoney(slice)} extra sale${preview ? " (illustrative)" : ""}, `
      + `against wage income from $0 to ${axisMoney(xMax)}. `
      + (rise == null
          ? "It stays at $0 across the whole wage range."
          : `It is $0 up to about ${axisMoney(rise)}, then rises and flattens at ${fullMoney(top)}.`)
      + ` At the current ${fullMoney(wage)} of wages it is ${fullMoney(pen(wage))}.`
      + (other > 0
          ? ` The ${fullMoney(other)} of interest is in both years, so it never registers as a penalty itself — `
            + `it spends the cheap brackets before the wages get to them`
            + (rise == null ? `.` : `, which is why the edge sits at a lower wage than it would on wages alone.`)
          : ``),
    xFmt: axisMoney,
    yFmt: axisMoney,
    hoverFmt: x => [["wages", fullMoney(x)], ["penalty", fullMoney(pen(x)), t.bad]],
  };
}

export { tokens, fullMoney };
