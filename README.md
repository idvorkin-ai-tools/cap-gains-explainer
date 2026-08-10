# Sell now or sell later?

An interactive model of what an extra capital-gains realization costs during a
working year versus a no-wage year — Washington State plus 2026 federal.

**Live:** https://idvorkin-ai-tools.github.io/cap-gains-explainer/

Models **only** capital-gains tax — federal LTCG, NIIT, and Washington. Income
tax and FICA on the wages are deliberately out of scope, because the question is
what wages do to *gains*.

## The finding

Wage income stacks *underneath* long-term capital gains, so it doesn't only pay
its own rate — it pushes gains out of the 0% federal bracket and takes the
standard deduction with it. At a $300K living draw, the timing penalty for
selling an extra $100K during a working year turns out to be a **cliff, not a
slope**: nothing below ~$250K of wages, then it appears and caps at $5,000.

## Constants

Every figure is cited in-page and in `tax.js`. Federal numbers are 2026
(Rev. Proc. 2025-32). **Washington's 2026 standard deduction has not been
published** — DOR has posted only 2024 ($270,000) and 2025 ($278,000), so this
uses the 2025 figure and says so.

The WA 9.9% surcharge threshold is *derived*, not entered: RCW 82.87.040(1)(b)
puts it $1,000,000 above the standard deduction, and RCW 82.87.150(2)(a) does not
list that $1M among the indexed amounts.

## Tests

```sh
node --test
```

Zero dependencies — Node's built-in runner. Covers the published benchmarks,
bracket-stacking order, deduction allocation, NIIT capping in both directions,
the WA tier math and its per-individual deduction, timing-penalty saturation,
and degenerate/inverted inputs.

## Not tax advice

A model for seeing the shape of the decision. Excludes the unsettled question of
whether WA capital-gains tax reduces federal amount realized under §164(a), plus
itemizing, AMT, ACA subsidies, IRMAA — and market risk, which is the actual
reason not to defer a sale forever.
