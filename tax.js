// Capital-gains tax model — Washington State + federal.
// Models ONLY capital-gains tax: federal LTCG, NIIT, and WA. Income tax and FICA
// are deliberately out of scope. Every constant is cited in CONSTANTS below.

/** RCW 82.87.040(1)(b): the 2.9% surcharge starts $1,000,000 above the WA
 *  standard deduction. RCW 82.87.150(2)(a) enumerates what gets indexed and
 *  this $1M is not on the list — it is fixed, so the kink is derived, never entered. */
export const WA_SURCHARGE_OFFSET = 1_000_000;

export const CONSTANTS = {
  mfj:    { stdded: 32_200, ltcg0: 98_900, ltcg15: 613_700, niit: 250_000 },
  single: { stdded: 16_100, ltcg0: 49_450, ltcg15: 545_500, niit: 200_000 },
  shared: { niitRate: 3.8, waExempt: 278_000, waRate: 0.07, waSurcharge: 0.029 },
};

export const SOURCES = {
  // §4 is "2026 Adjusted Items"; §3 covers 2025 and has only .01/.02.
  stdded:   "Rev. Proc. 2025-32 §4.14 — https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (2026)",
  ltcg:     "Rev. Proc. 2025-32 §4.03 — https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (2026)",
  niit:     "IRS — https://www.irs.gov/individuals/net-investment-income-tax (unindexed)",
  waExempt: "WA DOR — https://dor.wa.gov/taxes-rates/other-taxes/capital-gains-tax (2025; 2026 unpublished)",
  waRates:  "RCW 82.87.040 — https://app.leg.wa.gov/RCW/default.aspx?cite=82.87.040",
  waPerInd: "RCW 82.87.060 — per individual, NOT doubled for MFJ",
  stacking: "IRC §1(h)(1) — https://www.law.cornell.edu/uscode/text/26/1",
  interest: "IRC §61(a)(4) — interest is ordinary income, so it stacks under LTCG exactly as wages do",
  niiScope: "IRC §1411(c)(1)(A)(i) — interest is itself NII; the 3.8% on the interest ITSELF is out of scope here (a tax on the interest, not on the gains), but the interest still lifts MAGI",
};

/**
 * @param {number} wages   W-2 wages — present only in a working year
 * @param {number} ltcg    long-term capital gains realized
 * @param {object} k       constants: {stdded, ltcg0, ltcg15, niit, niitRate, waExempt}
 * @param {number} other   interest and other ordinary income — present in EVERY year,
 *                         working or not. Taxed identically to wages here: it stacks
 *                         underneath the gains, eats the standard deduction, and counts
 *                         toward NIIT MAGI. Only `sliceCost`/`timingPenalty` care which
 *                         is which, because only wages disappear in a no-wage year.
 */
export function calc(wages, ltcg, k, other = 0) {
  wages = Math.max(0, wages);
  ltcg  = Math.max(0, ltcg);
  other = Math.max(0, other);
  const ord = wages + other;                      // all ordinary income, one pool

  const dedn = Math.max(0, k.stdded);
  const c0   = Math.max(0, k.ltcg0);
  const c15  = Math.max(c0, k.ltcg15);           // guard: bands must not invert

  // IRC §1(h)(1): deduction offsets ordinary income first; the remainder
  // reduces the preferentially-taxed amount. LTCG then stacks ABOVE ordinary.
  const ordTaxable  = Math.max(0, ord - dedn);
  const dednLeft    = Math.max(0, dedn - ord);
  const ltcgTaxable = Math.max(0, ltcg - dednLeft);

  const start = ordTaxable, end = ordTaxable + ltcgTaxable;
  const band = (lo, hi) => Math.max(0, Math.min(end, hi) - Math.max(start, lo));
  const b0 = band(0, c0), b15 = band(c0, c15), b20 = band(c15, Infinity);
  const fedLtcg = b15 * 0.15 + b20 * 0.20;

  // NIIT: lesser of net investment income, or MAGI over the threshold.
  // MAGI is pre-standard-deduction, so the deduction does not reduce it, and all
  // ordinary income lifts it. NII is held to the GAINS: interest is itself net
  // investment income under §1411(c)(1)(A)(i), but the 3.8% it owes on its own
  // account is a tax on the interest, not on the gains — out of scope here for the
  // same reason income tax on the wages is.
  const nii = Math.max(0, Math.min(ltcg, ord + ltcg - k.niit)) * (k.niitRate / 100);

  // WA keys off GROSS realized gain; the federal deduction is irrelevant to it.
  const ex   = Math.max(0, k.waExempt);
  const kink = ex + WA_SURCHARGE_OFFSET;
  const over = Math.max(0, ltcg - ex);
  const wa = Math.min(over, WA_SURCHARGE_OFFSET) * 0.07
           + Math.max(0, ltcg - kink) * 0.099;

  return { b0, b15, b20, ltcgTaxable, fedLtcg, nii, wa, total: fedLtcg + nii + wa };
}

/** Cost of realizing `extra` on top of `base`, at a given wage level, with `other`
 *  ordinary income (interest) alongside. */
export function sliceCost(wages, base, extra, k, other = 0) {
  return calc(wages, base + extra, k, other).total - calc(wages, base, k, other).total;
}

/** What you lose by selling `extra` in a working year instead of a no-wage year.
 *  Only the wages go away in the no-wage year — `other` is there in both. */
export function timingPenalty(wages, base, extra, k, other = 0) {
  return sliceCost(wages, base, extra, k, other) - sliceCost(0, base, extra, k, other);
}

export const presets = status => ({ ...CONSTANTS[status], ...CONSTANTS.shared });
