// Zero-dependency tests: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { calc, sliceCost, timingPenalty, presets, WA_SURCHARGE_OFFSET, CONSTANTS } from "./tax.js";

const M = presets("mfj");
const S = presets("single");
const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (±${tol})`);

test("MFJ benchmark: $300K LTCG, no wages", () => {
  const r = calc(0, 300_000, M);
  near(r.fedLtcg, 25_335);
  near(r.nii, 1_900);
  near(r.wa, 1_540);
  near(r.total, 28_775);
  near(r.total / 300_000, 0.0959, 0.0001);
});

test("MFJ benchmarks across the retirement draw range", () => {
  const expected = { 200_000: 10_335, 300_000: 28_775, 400_000: 54_575, 500_000: 80_375 };
  for (const [draw, total] of Object.entries(expected)) near(calc(0, +draw, M).total, total);
});

test("marginal rate is flat at 25.8% between $300K and $500K", () => {
  for (const base of [300_000, 350_000, 400_000, 450_000]) {
    near(sliceCost(0, base, 50_000, M) / 50_000, 0.258, 0.0005);
  }
});

test("bands always sum to taxable LTCG", () => {
  for (const w of [0, 50_000, 200_000, 700_000])
    for (const l of [0, 100_000, 300_000, 1_500_000]) {
      const r = calc(w, l, M);
      near(r.b0 + r.b15 + r.b20, r.ltcgTaxable, 0.001);
    }
});

test("deduction offsets ordinary income first, remainder against gains", () => {
  // no wages: full deduction shelters gains
  assert.equal(calc(0, 300_000, M).ltcgTaxable, 300_000 - M.stdded);
  // wages exceed deduction: gains fully taxable
  assert.equal(calc(100_000, 300_000, M).ltcgTaxable, 300_000);
  // wages partially consume it
  assert.equal(calc(10_000, 300_000, M).ltcgTaxable, 300_000 - (M.stdded - 10_000));
});

test("LTCG stacks above ordinary income — wages erode the 0% band", () => {
  assert.equal(calc(0, 300_000, M).b0, M.ltcg0);
  assert.equal(calc(M.stdded + M.ltcg0, 300_000, M).b0, 0);
  assert.ok(calc(60_000, 300_000, M).b0 < M.ltcg0);
});

test("NIIT is the lesser of NII and MAGI over threshold, floored at zero", () => {
  assert.equal(calc(0, 100_000, M).nii, 0);                       // MAGI below threshold
  near(calc(0, 300_000, M).nii, 50_000 * 0.038);                  // capped by MAGI excess
  near(calc(400_000, 100_000, M).nii, 100_000 * 0.038);           // capped by NII itself
});

test("WA: exemption, 7% band, then 9.9% above the derived kink", () => {
  assert.equal(calc(0, 278_000, M).wa, 0);
  near(calc(0, 300_000, M).wa, 22_000 * 0.07);
  const kink = M.waExempt + WA_SURCHARGE_OFFSET;
  near(calc(0, kink, M).wa, WA_SURCHARGE_OFFSET * 0.07);
  near(calc(0, kink + 100_000, M).wa, WA_SURCHARGE_OFFSET * 0.07 + 100_000 * 0.099);
});

test("WA surcharge kink is derived, so moving the exemption moves it too", () => {
  const shifted = { ...M, waExempt: 286_000 };
  // the 7% band stays exactly $1M wide regardless of the exemption
  const atKink = calc(0, 286_000 + WA_SURCHARGE_OFFSET, shifted);
  near(atKink.wa, WA_SURCHARGE_OFFSET * 0.07);
});

test("WA deduction is per individual — identical for MFJ and Single (RCW 82.87.060)", () => {
  assert.equal(M.waExempt, S.waExempt);
  assert.equal(calc(0, 500_000, M).wa, calc(0, 500_000, S).wa);
});

test("wages never move the WA bill", () => {
  const set = new Set([0, 100_000, 400_000, 800_000].map(w => Math.round(calc(w, 400_000, M).wa)));
  assert.equal(set.size, 1);
});

test("timing penalty is zero below the threshold and caps above it", () => {
  assert.equal(timingPenalty(0, 300_000, 100_000, M), 0);
  assert.equal(timingPenalty(200_000, 300_000, 100_000, M), 0);
  assert.ok(timingPenalty(300_000, 300_000, 100_000, M) > 0);
  near(timingPenalty(400_000, 300_000, 100_000, M),
       timingPenalty(800_000, 300_000, 100_000, M));       // saturates
});

test("single-filer constants differ from MFJ where they should", () => {
  assert.equal(S.stdded, 16_100);
  assert.equal(S.ltcg0, 49_450);
  assert.equal(S.ltcg15, 545_500);
  assert.equal(S.niit, 200_000);
});

test("degenerate inputs never produce NaN or negatives", () => {
  for (const [w, l] of [[0,0],[0,1],[1,0],[-5,-5],[1e9,1e9]]) {
    const r = calc(w, l, M);
    for (const [key, v] of Object.entries(r)) {
      assert.ok(Number.isFinite(v), `${key} not finite for (${w},${l})`);
      assert.ok(v >= 0, `${key} negative for (${w},${l})`);
    }
  }
});

test("inverted bracket constants are clamped rather than double-counting", () => {
  const bad = { ...M, ltcg0: 600_000, ltcg15: 100_000 };   // c15 < c0
  const r = calc(0, 400_000, bad);
  near(r.b0 + r.b15 + r.b20, r.ltcgTaxable, 0.001);
  assert.ok(r.b15 >= 0 && r.b20 >= 0);
});

test("tax is monotonic in gains", () => {
  let prev = -1;
  for (let l = 0; l <= 2_000_000; l += 50_000) {
    const t = calc(0, l, M).total;
    assert.ok(t >= prev, `not monotonic at ${l}`);
    prev = t;
  }
});

// ── Interest / other ordinary income — present in EVERY year, working or not ──

test("interest of zero reproduces every pre-interest number", () => {
  for (const [w, l] of [[0, 300_000], [200_000, 300_000], [400_000, 100_000], [0, 1_500_000]])
    assert.deepEqual(calc(w, l, M, 0), calc(w, l, M));
  assert.equal(sliceCost(300_000, 300_000, 100_000, M, 0), sliceCost(300_000, 300_000, 100_000, M));
  assert.equal(timingPenalty(400_000, 300_000, 100_000, M, 0), timingPenalty(400_000, 300_000, 100_000, M));
});

test("interest is ordinary income — a dollar of it taxes gains exactly like a dollar of wages", () => {
  for (const amt of [10_000, 50_000, 150_000, 400_000])
    for (const l of [100_000, 300_000, 700_000])
      assert.deepEqual(calc(0, l, M, amt), calc(amt, l, M),
        `interest ${amt} != wages ${amt} at ${l} of gains`);
  // and it splits: half wages plus half interest is the same pool
  assert.deepEqual(calc(100_000, 300_000, M, 100_000), calc(200_000, 300_000, M));
});

test("interest raises the no-wage-year gains tax", () => {
  const bare = calc(0, 300_000, M).total;                       // $28,775 benchmark
  assert.ok(calc(0, 300_000, M, 60_000).total > bare);
  // it erodes the 0% band and reallocates the deduction, same as wages
  assert.ok(calc(0, 300_000, M, 60_000).b0 < M.ltcg0);
  assert.equal(calc(0, 300_000, M, M.stdded + M.ltcg0).b0, 0);
  assert.equal(calc(0, 300_000, M, 100_000).ltcgTaxable, 300_000);
});

test("interest lifts NIIT MAGI but is not itself charged NIIT here", () => {
  // gains alone sit below the threshold; the interest pushes MAGI over it
  assert.equal(calc(0, 100_000, M).nii, 0);
  near(calc(0, 100_000, M, 200_000).nii, 50_000 * 0.038);        // MAGI 300K, excess 50K
  // NII stays capped by the GAINS — more interest can never charge more than the gains
  near(calc(0, 100_000, M, 900_000).nii, 100_000 * 0.038);
  near(calc(0, 100_000, M, 5_000_000).nii, 100_000 * 0.038);
});

test("interest never moves the WA bill — WA keys off gains alone", () => {
  const set = new Set([0, 50_000, 300_000, 900_000].map(i => Math.round(calc(0, 400_000, M, i).wa)));
  assert.equal(set.size, 1);
  assert.equal(calc(0, 278_000, M, 500_000).wa, 0);
});

test("the wages band is measured with interest present in BOTH columns", () => {
  const wagesCost = (w, l, i) => calc(w, l, M, i).total - calc(0, l, M, i).total;
  // with no interest at all, working costs $31,870 on a $300K draw at $400K of wages
  near(wagesCost(400_000, 300_000, 0), 31_870);
  // interest eats the same 0% band and deduction the wages would have eaten, so the
  // more interest there is, the less damage is left for the wages to do
  let prev = Infinity;
  for (const i of [0, 100_000, 300_000, 600_000]) {
    const c = wagesCost(400_000, 300_000, i);
    assert.ok(c < prev, `wages cost did not fall at interest ${i}`);
    prev = c;
  }
  // and it reaches exactly zero once the interest alone has pushed the gains entirely
  // into the 20% band — from there the wages have nothing left to displace
  assert.equal(wagesCost(400_000, 300_000, M.stdded + M.ltcg15), 0);
  assert.equal(wagesCost(400_000, 300_000, 900_000), 0);
  // the pool is symmetric: $400K of wages and $400K of interest cost the gains the same
  near(calc(400_000, 300_000, M, 0).total, calc(0, 300_000, M, 400_000).total);
});

test("interest shifts the timing penalty, in both scenarios at once", () => {
  // the cliff at $300K of wages is unchanged when interest is zero
  assert.equal(timingPenalty(200_000, 300_000, 100_000, M, 0), 0);
  // enough interest and the penalty is already spent — nothing left for wages to take
  assert.equal(timingPenalty(400_000, 300_000, 100_000, M, 400_000), 0);
  // interest alone, with no wages, makes a slice cost what a bare year gave away free:
  // the first $100K of gains is untaxed in an empty year, but not on top of interest
  assert.equal(sliceCost(0, 0, 100_000, M, 0), 0);
  near(sliceCost(0, 0, 100_000, M, 200_000), 16_900);
  // above the 0% band the marginal rate is the same 25.8% with or without interest —
  // interest moves the base bill, not the rate on a slice already in the 15% band
  near(sliceCost(0, 300_000, 100_000, M, 200_000), sliceCost(0, 300_000, 100_000, M, 0));
  // timingPenalty subtracts a no-wage year that KEEPS the interest, so it never
  // exceeds the same penalty measured with no interest at all
  for (const i of [0, 50_000, 200_000, 600_000])
    assert.ok(timingPenalty(500_000, 300_000, 100_000, M, i)
              <= timingPenalty(500_000, 300_000, 100_000, M, 0) + 1);
});

test("interest keeps the invariants: bands sum, monotonic, never NaN or negative", () => {
  for (const i of [0, 25_000, 300_000, -5, 1e9])
    for (const [w, l] of [[0, 0], [0, 300_000], [200_000, 100_000], [1e9, 1e9]]) {
      const r = calc(w, l, M, i);
      near(r.b0 + r.b15 + r.b20, r.ltcgTaxable, 0.001);
      for (const [key, v] of Object.entries(r)) {
        assert.ok(Number.isFinite(v), `${key} not finite for (${w},${l},${i})`);
        assert.ok(v >= 0, `${key} negative for (${w},${l},${i})`);
      }
    }
  assert.deepEqual(calc(0, 300_000, M, -5), calc(0, 300_000, M, 0));   // clamped
  let prev = -1;
  for (let i = 0; i <= 800_000; i += 25_000) {
    const t = calc(0, 300_000, M, i).total;
    assert.ok(t >= prev, `gains tax not monotonic in interest at ${i}`);
    prev = t;
  }
});
