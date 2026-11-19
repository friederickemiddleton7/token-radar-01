# Lensa — token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/friederickemiddleton7/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/friederickemiddleton7/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A ranked radar of the protocols in the sealed snapshot that have no token yet, plus an explicitly
separate cohort of the protocols whose token already trades. Node 22, standard library only, no build,
no network.

```
node main.ts --input /input/snapshot.json --output /output     # what the grader runs
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json   # a local run
node main.ts --input ../input/snapshot.json --output out --preview   # board + data, no screenshots
```

`main.ts` reads `/input/snapshot.json`, builds both cohorts with `dashboard/engine.mjs`, writes
`/output/board.json`, writes the page's data to `/output/data.js`, copies `dashboard/` and `screenshots/`
to `/output`, and writes `/output/dossier.json` with the vendored `vendor/makefun-board.ts`.
The page (`dashboard/index.html`, `app.js`, `app.css`, `engine.mjs`) recomputes the identical model in the
browser from `../data.js`, which carries raw snapshot fields only.

## The two cohorts

The snapshot records a token when `gecko_id` or `symbol` is set. That field pair, not a list of names,
splits the board:

- **Cohort A, pre-token** — 195 rows: the 40 watchlist slugs plus every protocol the snapshot records no
  token for and that is not a bridge, liquid-staking, restaked-BTC, CEX or versioned product.
- **Cohort B, trading** — 416 rows: every protocol whose token already trades, valued by the same model
  so its error can be measured against a market cap that exists.

The two are ranked separately and never merged into one ordering.

## The value model

`pooledMultiple` pools the ${'128'} live-token comparables with a positive market cap and TVL. For each
candidate it takes the median log `mcap_usd / tvl_usd` of the whole pool, then of its own TVL band, then of
its category, then of the category inside the band, and shrinks each level toward the previous one with the
empirical-Bayes weight `n/(n+k)`, k = 4. A one-comparable category therefore moves the estimate by 20% at
most, and every row prints n, the comparables actually used (`n_eff`, the union of band and category) and a
low/high interval built from the peer quartiles.

`valueOf` then multiplies: TVL × pooled multiple × growth (35% pass-through of the seven-day change, clamped
to ±40%) × maturity (0.70 at zero days without a token to 1.00 at three years) × chain count (at most +9%).

The multiple is held under a ceiling read from the snapshot itself: the 90th percentile of the 128
comparable ratios (2.96× in this snapshot). The earlier 0.30× ceiling is gone; it came from nowhere in the
data and bound the top seats.

## Farm plans

`farmPlan` writes seven steps per protocol from the row's own figures — primary chain and its gas range, a
capital ladder from TVL, bridge fee, exit test, review cadence from the protocol's age. Every step carries a
dollar cost and a duration in minutes; the shortest step in the board is 181 characters.

## Screenshots

`1-board.png` (both cohorts in one frame, separated), `2-detail.png` (one protocol's dossier and plan) and
`3-filtered.png` (a filter applied), each ≤512 KiB, long side ≤1440, short side ≥800, captured from the
built page.

MIT licensed.