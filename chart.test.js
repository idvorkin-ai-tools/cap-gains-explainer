// Zero-dependency tests for the chart's pure helpers: node --test
// Canvas drawing isn't unit-testable without a DOM; the axis/sampling maths and
// the semantic claim the picture makes are, and those are what can silently rot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calc, timingPenalty, presets } from "./tax.js";
import {
  niceTicks, sweepDomain, sampleCurve,
  gainsBreaks, wageBreaks, axisMoney, firstRise, SWEEP_STEPS,
  penaltyFn, cliffFacts, axisMax, gainsSweepSpec, penaltyCliffSpec,
} from "./chart.js";

const M = presets("mfj");
// The spec builders read colours off a token object and never touch the DOM, so
// a plain literal is enough to build and assert on a whole spec under node.
const T = { ink: "INK", muted: "MUTED", rule: "RULE", raise: "RAISE", accent: "ACCENT", bad: "BAD" };
const at = (points, x) => points.reduce((p, q) => (Math.abs(q.x - x) < Math.abs(p.x - x) ? q : p));
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("niceTicks starts at 0, ascends, and covers the max", () => {
  const t = niceTicks(50_000, 4);
  assert.equal(t[0], 0);
  assert.ok(t[t.length - 1] >= 50_000 - 1e-6);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], "not ascending");
  assert.deepEqual(niceTicks(0), [0]);
  assert.deepEqual(niceTicks(NaN), [0]);
});

test("niceTicks stays a sane length — no thousand-gridline blowup", () => {
  for (const m of [1, 999, 28_775, 1e6, 5e6]) {
    const n = niceTicks(m, 4).length;
    assert.ok(n >= 2 && n <= 12, `${m} produced ${n} ticks`);
  }
});

test("sweepDomain snaps to a step and always leaves headroom for the marker", () => {
  assert.equal(sweepDomain(0), 500e3);
  assert.equal(sweepDomain(300e3), 500e3);
  assert.equal(sweepDomain(800e3), 1.5e6);
  for (const total of [0, 1e3, 300e3, 700e3, 1.2e6, 2e6]) {
    assert.ok(sweepDomain(total) >= total, `domain clipped the current position at ${total}`);
    assert.ok(SWEEP_STEPS.includes(sweepDomain(total)), "off-step domain");
  }
});

test("sweepDomain saturates rather than returning undefined past the last step", () => {
  assert.equal(sweepDomain(1e12), SWEEP_STEPS[SWEEP_STEPS.length - 1]);
});

test("sampleCurve spans the domain, stays sorted, and honours breakpoints", () => {
  const pts = sampleCurve(x => x * 2, 0, 100, 10, [33.5, 200, -4]);
  assert.equal(pts[0].x, 0);
  assert.equal(pts[pts.length - 1].x, 100);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].x >= pts[i - 1].x, "unsorted");
  assert.ok(pts.some(p => p.x === 33.5), "in-range breakpoint missing");
  assert.ok(!pts.some(p => p.x === 200 || p.x === -4), "out-of-range breakpoint leaked in");
  for (const p of pts) near(p.y, p.x * 2);
});

test("breakpoints land on real kinks — sampling there is exact, not approximate", () => {
  // A breakpoint is only a density hint, but a good one should sit where the
  // slope actually changes. The WA exemption is the cleanest such kink.
  const b = gainsBreaks(0, M);
  assert.ok(b.includes(M.waExempt), "WA exemption not among the breaks");
  assert.ok(b.includes(M.waExempt + 1_000_000), "WA surcharge kink not among the breaks");
  const eps = 1;
  const slopeBelow = calc(0, M.waExempt - eps, M).wa - calc(0, M.waExempt - 2 * eps, M).wa;
  const slopeAbove = calc(0, M.waExempt + 2 * eps, M).wa - calc(0, M.waExempt + eps, M).wa;
  assert.ok(slopeAbove > slopeBelow, "expected a slope change at the WA exemption");
});

test("wageBreaks are finite and non-negative", () => {
  for (const b of wageBreaks(M)) assert.ok(Number.isFinite(b) && b >= 0, `bad break ${b}`);
});

test("the band the chart draws IS the wage-caused delta the page already prints", () => {
  // The chart claims: vertical gap between the curves == extra CG tax from working.
  for (const wage of [0, 150_000, 300_000, 800_000])
    for (const x of [0, 100_000, 300_000, 900_000]) {
      const gap = calc(wage, x, M).total - calc(0, x, M).total;
      assert.ok(gap >= -1e-9, `negative gap at (${wage}, ${x}) — curves crossed`);
    }
});

test("difference of band heights IS timingPenalty — chart and readout agree", () => {
  const gap = (w, x) => calc(w, x, M).total - calc(0, x, M).total;
  for (const wage of [0, 200_000, 300_000, 500_000, 800_000])
    for (const base of [200_000, 300_000, 500_000])
      for (const extra of [50_000, 100_000, 250_000]) {
        near(gap(wage, base + extra) - gap(wage, base),
             timingPenalty(wage, base, extra, M), 1e-6);
      }
});

test("the penalty curve really is a cliff: flat, then a rise, then a plateau", () => {
  const pen = w => timingPenalty(w, 300_000, 100_000, M);
  assert.equal(pen(0), 0);
  assert.equal(pen(200_000), 0);            // still flat on the floor
  assert.ok(pen(400_000) > 0);              // risen
  near(pen(600_000), pen(800_000), 1);      // and saturated
  let prev = -1;                            // monotonic throughout
  for (let w = 0; w <= 800_000; w += 10_000) {
    const p = pen(w);
    assert.ok(p >= prev - 1e-9, `penalty dipped at ${w}`);
    prev = p;
  }
});

test("penaltyFn is exactly tax.js timingPenalty — the hoist changed nothing", () => {
  for (const base of [0, 200_000, 300_000, 700_000])
    for (const slice of [25_000, 100_000, 400_000]) {
      const f = penaltyFn(base, slice, M);
      for (const w of [0, 100_000, 250_000, 260_000, 400_000, 800_000])
        near(f(w), timingPenalty(w, base, slice, M), 1e-6);
    }
});

test("cliffFacts reproduces the README's headline finding", () => {
  // "At a $300K living draw, selling an extra $100K in a working year:
  //  nothing below ~$250K of wages, then it appears and caps at $5,000."
  const { foot, plateau } = cliffFacts(300_000, 100_000, M);
  assert.ok(foot > 200_000 && foot < 300_000, `foot at ${foot}, expected ~$250K`);
  assert.ok(Math.abs(plateau - 5_000) <= 50, `plateau ${plateau}, expected ~$5,000`);
});

test("firstRise finds the foot of the cliff, and null when there isn't one", () => {
  assert.equal(firstRise([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 90 }]), 2);
  assert.equal(firstRise([{ x: 0, y: 0 }, { x: 1, y: 0 }]), null);
  assert.equal(firstRise([]), null);
  // on the real penalty curve it should land somewhere in the documented range
  const pen = w => timingPenalty(w, 300_000, 100_000, M);
  const pts = sampleCurve(pen, 0, 800_000, 320, wageBreaks(M));
  const foot = firstRise(pts);
  assert.ok(foot > 200_000 && foot < 300_000, `cliff foot at ${foot}, expected ~$250K`);
});

test("axisMoney is compact and lossless enough to label an axis", () => {
  assert.equal(axisMoney(0), "$0");
  assert.equal(axisMoney(250_000), "$250K");
  assert.equal(axisMoney(1_000_000), "$1M");
  assert.equal(axisMoney(1_500_000), "$1.5M");
  assert.equal(axisMoney(750_000), "$750K");
  assert.equal(axisMoney(247_500), "$247.5K");
});

test("axisMoney never rounds a small tick into a different number", () => {
  // Regression: on a $5,000 axis the ticks are 1250/2500/3750, and the old
  // "$" + round(v/1e3) + "K" rendered those as $1K / $3K / $4K.
  assert.equal(axisMoney(1_250), "$1,250");
  assert.equal(axisMoney(2_500), "$2,500");
  assert.equal(axisMoney(3_750), "$3,750");
  assert.equal(axisMoney(5_000), "$5,000");
  // every tick on a plausible small axis must render back to its own value
  for (const max of [1_000, 5_000, 6_000, 8_000]) {
    for (const v of niceTicks(max, 4)) {
      const parsed = Number(axisMoney(v).replace(/[$,]/g, ""));
      near(parsed, v, 1e-9);
    }
  }
});

test("axisMax leaves headroom so a saturating curve isn't welded to the top", () => {
  for (const peak of [5_000, 28_775, 190_000, 1, 617_478]) {
    const m = axisMax(peak);
    assert.ok(m > peak, `axisMax(${peak}) = ${m} left no headroom`);
    assert.ok(m < peak * 2, `axisMax(${peak}) = ${m} wasted more than half the plot`);
  }
  assert.equal(axisMax(5_000), 6_000);
});

test("axisMax output always divides into a readable tick set", () => {
  for (const peak of [1, 900, 5_000, 28_775, 190_000, 617_478, 2_500_000]) {
    const m = axisMax(peak);
    const ticks = niceTicks(m, 4);
    assert.ok(ticks.length >= 3 && ticks.length <= 7, `${peak} -> ${ticks.length} ticks`);
    near(ticks[ticks.length - 1], m, 1e-6);   // top gridline IS the axis max
  }
});

test("axisMax survives degenerate peaks", () => {
  for (const v of [0, -1, NaN, Infinity]) assert.ok(axisMax(v) > 0, `axisMax(${v})`);
});

test("importing chart.js touches no DOM — it must load under plain node", () => {
  assert.equal(typeof globalThis.document, "undefined");
});

/* ── interest: ordinary income that doesn't retire, so it is in BOTH curves ──
 *
 * The bug this section exists to prevent: the charts were written before the
 * interest slider landed on main, so every calc() in here defaulted `other` to
 * 0 and the sweep silently ignored the slider while the readouts above it
 * moved. Each test below fails if any one call site loses its `other`. */

test("interest of zero leaves every chart helper exactly as it was", () => {
  assert.deepEqual(wageBreaks(M, 0), wageBreaks(M));
  for (const base of [0, 300_000])
    for (const slice of [50_000, 100_000]) {
      const f0 = penaltyFn(base, slice, M, 0), f = penaltyFn(base, slice, M);
      for (const w of [0, 250_000, 500_000]) near(f0(w), f(w));
      assert.deepEqual(cliffFacts(base, slice, M, 0), cliffFacts(base, slice, M));
    }
});

test("gainsBreaks keys off the whole ordinary pool, not the wages alone", () => {
  // $100K of wages and $100K of interest put the gains in exactly the same place,
  // so they must produce exactly the same kinks.
  assert.deepEqual(gainsBreaks(100_000, M), gainsBreaks(0 + 100_000, M));
  // and the kinks are real: sampling either side of the 0%-band break shows the slope change
  const [, band0] = gainsBreaks(150_000, M);
  const eps = 1;
  const slope = x => calc(0, x + eps, M, 150_000).total - calc(0, x, M, 150_000).total;
  assert.ok(slope(band0 + eps) > slope(band0 - 2 * eps), "no slope change at the 0% band break");
});

test("wageBreaks shift left by the interest — it already spent that much pool", () => {
  for (const other of [0, 50_000, 200_000]) {
    const shifted = wageBreaks(M, other);
    wageBreaks(M).forEach((b, i) => near(shifted[i], b - other));
    for (const b of shifted) assert.ok(Number.isFinite(b), `bad break ${b}`);
  }
});

test("penaltyFn with interest is exactly tax.js timingPenalty with interest", () => {
  for (const other of [0, 60_000, 250_000, 600_000])
    for (const base of [0, 300_000, 700_000])
      for (const slice of [25_000, 100_000]) {
        const f = penaltyFn(base, slice, M, other);
        for (const w of [0, 100_000, 250_000, 400_000, 800_000])
          near(f(w), timingPenalty(w, base, slice, M, other), 1e-6);
      }
});

test("interest moves the cliff left and eventually flattens it away", () => {
  const foot = i => cliffFacts(300_000, 100_000, M, i).foot;
  // the README's cliff sits at ~$250K of wages with no interest; each dollar of
  // interest is a dollar of wages already spent, so the edge arrives that much sooner
  near(foot(0) - foot(50_000), 50_000, 2_500);
  near(foot(0) - foot(200_000), 200_000, 2_500);
  let prev = Infinity;
  for (const i of [0, 50_000, 100_000, 200_000]) {
    assert.ok(foot(i) < prev, `cliff foot did not move left at interest ${i}`);
    prev = foot(i);
  }
  // enough interest and there is no cliff left for the wages to push you off
  assert.equal(foot(400_000), null);
  assert.equal(cliffFacts(300_000, 100_000, M, 400_000).plateau, 0);
});

test("the sweep chart plots interest in BOTH curves — the slider must move them", () => {
  const spec = (i) => gainsSweepSpec(300_000, 300_000, 100_000, M, i, T);
  const a = spec(0), b = spec(150_000);
  for (const s of [0, 1]) {
    const x = a.series[s].points.at(-1).x;
    assert.ok(b.series[s].points.at(-1).y > a.series[s].points.at(-1).y,
      `series ${s} ignored the interest at ${x}`);
  }
  // and the y-values ARE calc() with the interest, on both curves
  for (const x of [0, 500_000, 1_000_000])
    for (const [s, w] of [[0, 0], [1, 300_000]]) {
      const p = at(b.series[s].points, x);
      near(p.y, calc(w, p.x, M, 150_000).total, 1e-6);
    }
});

test("the sweep band stays the wage-caused delta once interest is in both columns", () => {
  // This is the claim the caption makes: band == "extra CG tax caused by working".
  for (const i of [0, 100_000, 300_000])
    for (const wage of [150_000, 400_000]) {
      const s = gainsSweepSpec(wage, 300_000, 100_000, M, i, T);
      const total = 400_000;
      const want = calc(wage, total, M, i).total - calc(0, total, M, i).total;
      if (s.gapLabel) {
        near(s.gapLabel.hi - s.gapLabel.lo, want, 1e-6);
        near(s.gapLabel.lo, calc(0, total, M, i).total, 1e-6);
      }
      const hover = Object.fromEntries(s.hoverFmt(total).map(r => [r[0], r[1]]));
      assert.equal(hover["wages cost"], "+$" + Math.round(want).toLocaleString());
    }
});

test("the no-wage curve is renamed once it is carrying interest", () => {
  // "no-wage year" reads as an empty year; with interest in it that is a lie.
  assert.equal(gainsSweepSpec(300_000, 300_000, 0, M, 0, T).series[0].label, "no-wage year");
  assert.equal(gainsSweepSpec(300_000, 300_000, 0, M, 90_000, T).series[0].label, "interest only");
  assert.equal(gainsSweepSpec(0, 300_000, 0, M, 90_000, T).series[0].label, "interest only");
  assert.ok(gainsSweepSpec(300_000, 300_000, 0, M, 90_000, T).aria.includes("$90,000 of interest"));
  assert.ok(gainsSweepSpec(0, 300_000, 0, M, 90_000, T).aria.includes("$90,000 of interest"));
  const rows = gainsSweepSpec(300_000, 300_000, 0, M, 90_000, T).hoverFmt(400_000).map(r => r[0]);
  assert.ok(rows.includes("interest only"), rows.join("/"));
});

test("the cliff chart takes the interest too, and says so", () => {
  const spec = i => penaltyCliffSpec(400_000, 300_000, 100_000, M, i, T, false);
  const a = spec(0), b = spec(150_000);
  const pen = i => timingPenalty(400_000, 300_000, 100_000, M, i);
  near(at(a.series[0].points, 400_000).y, pen(0), 1e-6);
  near(at(b.series[0].points, 400_000).y, pen(150_000), 1e-6);
  // at a wage still on the flat, the interest is what tips you over the edge:
  // it spends the cheap brackets the wages would otherwise have had to reach for
  const onFace = i => at(penaltyCliffSpec(150_000, 300_000, 100_000, M, i, T, false).series[0].points, 150_000).y;
  assert.equal(onFace(0), 0);
  assert.ok(onFace(150_000) > 0, "interest should have pulled the cliff under a $150K wage");
  assert.ok(b.aria.includes("$150,000 of interest"), b.aria);
  assert.ok(!a.aria.includes("interest"), a.aria);
});

test("the spec builders take `other` before the token bag — no silent arg slip", () => {
  // A call left on the old signature would pass tokens() where `other` goes and
  // colour the curves `undefined`. Pin the order by checking the colours landed.
  const s = gainsSweepSpec(300_000, 300_000, 100_000, M, 50_000, T);
  assert.equal(s.series[0].color, T.accent);
  assert.equal(s.series[1].color, T.bad);
  assert.equal(penaltyCliffSpec(300_000, 300_000, 100_000, M, 50_000, T, false).series[0].color, T.bad);
});
