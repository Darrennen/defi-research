# EMA Cross Scanner

Market-wide golden/death cross scanner across 1h / 4h / 12h / 1d / 1w for every
Binance USDT spot pair.

Two venues: **Binance spot** (USDT pairs) and **Hyperliquid perps**.

```bash
python3 scanner.py                       # both venues → data/scan.json (~10 min)
python3 scanner.py --venue binance       # Binance only (~4 min)
python3 scanner.py --venue hyperliquid   # HL only (~6 min)
python3 server.py                        # dashboard → http://localhost:8790
```

No dependencies — Python stdlib only. The dashboard's **Rescan market** button
re-runs the scanner in place.

## What it computes

For each symbol × timeframe × EMA pair (`50/200` classic, `21/55` faster):

| field | meaning |
|---|---|
| `state` | `bull` (fast EMA above slow) / `bear` |
| `cross` / `bars_since` | most recent crossover and how many closed bars ago |
| `pct_since_cross` | price change since the cross bar |
| `mfe_pct` / `mae_pct` | best / worst excursion since the cross — did the signal hold? |
| `spread_pct` | signed EMA separation (regime conviction) |
| `eta_bars` | **estimate**: bars to the next cross, extrapolating the spread's rate of change over 10 bars. `null` = diverging |

## Decisions that matter

- **1000 bars per series, not 500.** An EMA200 seeded at bar 200 of a 500-bar
  window carries up to **0.8% warmup error** (measured on SOLUSDT 1d); at 1000
  bars it is ~0.002%. A cross *is* the two EMAs meeting, so sub-1% error on the
  slow EMA invents crosses that never happened.
- **Closed candles only, cut at one instant for every venue.** Venues are scanned
  sequentially and HL is throttled to 4 workers, so it used to finish ~1h after
  Binance and pick up one extra 1h bar — 89 of 113 overlapping 1h rows disagreed
  on `bars_since` by exactly 1 with an *identical* `cross_time`. Every series is
  now truncated to bars closing at or before the scan's start time.
- **Hyperliquid weekly is resampled from 1d, not fetched.** HL buckets `1w` by raw
  epoch division and epoch 0 was a Thursday, so its native weekly candles run
  Thu→Wed while Binance and TradingView run Mon→Sun. Different weekly closes give
  different EMAs and different cross bars. Rebuilding from HL's ~1258 real daily
  bars yields the same ~180 weeks its own endpoint returns, Monday-anchored, and
  the leading partial week is dropped so the EMA seed isn't fed a stub bar.
- **Pegged assets are dropped** — detected from price history (whole range within
  ±2% of $1.00), not a hardcoded ticker list, so new stablecoin listings are
  caught without maintenance. Dropped names are reported in `excluded_pegged`.
- **Scan wide, filter in the UI.** The scanner takes everything above $100k 24h
  volume (~400 pairs); the dashboard defaults to a $1M floor. Illiquid coins
  produce technically-valid but untradeable signals.
- **Insufficient history is shown as `·`, never as a neutral or faked value.**
  Weekly EMA200 needs 200 weeks, which most alts don't have — only ~43 of the
  liquid set qualify.
- **"No cross" and "we could not have seen one" are different claims.** A series
  needs `NO_CROSS_WARMUP` (3.5) × the slow period past its seed before a null
  result means anything. Measured on 18 coins with 2400+ daily bars, comparing
  each truncated window against the cross found with full history (2208
  judgements): at 1.5× the slow period a series reports a **false "no cross" 7.7%**
  of the time and puts the cross on the **wrong bar in 62%** of cases; at 3.5×
  those fall to 0.6% and 12%. Below the threshold the cell reads `too short`, not
  `no cross`. This bites Hyperliquid hardest — it lists most coins years after
  Binance (ICP perp: 2025-11, DASH: 2026-01), so HL ALGO 1d has 411 bars and no
  detectable cross while Binance shows a death cross 310 bars back. Truncating
  *Binance* to HL's start date reproduces HL's result exactly, so this is short
  history, not an HL data defect.
- **Even at full depth the cross bar is only ~92% reliable.** The same experiment
  puts a 1000-bar series (4× the slow period) at 92% agreement with 2400-bar
  ground truth. `bars_since` is good to a bar or two, not exact.
- Green/red is ΔE 4.1 under deuteranopia, so a ▲/▼ glyph and the bar count carry
  the state in every cell; colour only reinforces.

## Measured accuracy (`python3 audit.py`)

Audited against **full paginated history** for 40 liquid coins × 5 timeframes
(181 series, 484,368 bars).

**Numeric — the EMA values are effectively exact:**

| | median | p95 | max |
|---|---|---|---|
| fast EMA error | 0.0000% | 0.0000% | 0.0000% |
| slow EMA error | 0.0000% | 0.0062% | 0.0372% |

Cross-verdict disagreement vs full history: **5 / 236 (2.1%)**, all ±1–2 bars on
crosses 397–530 bars old. **Zero disagreements on crosses ≤100 bars old** — the
actionable zone is exact. (Before the warmup fix this was 15/236 = 6.4%, including
ACE 12h reporting 608 bars vs 1157 truth: spurious crosses in the EMA200 seed region.)

**Signal — the crosses are a weak predictor.** Forward return after every cross vs
the unconditional base rate over the same bars (EMA 50/200, median edge in
percentage points):

| timeframe | golden, 20 bars | death, 20 bars | n |
|---|---|---|---|
| 1h | **−0.40** (worse than nothing) | +0.11 | ~550 |
| 4h | +0.19 | +0.35 | ~395 |
| 12h | +0.87 | −0.65 | ~235 |
| 1d | **+3.58** | −1.39 | ~130 |

- Win rates sit at **40–53%** against a 46–48% base rate. This is not a high-accuracy signal.
- **1h golden crosses underperform the base rate** — on the hourly they are noise.
- The `21/55` preset is mostly *negative* edge on 1h/4h. Faster ≠ better.
- Mean ≫ median everywhere (1d golden: mean +11.8%, median +2.3%). The distribution
  is fat-tailed — most crosses go nowhere, a few run hard. Any edge lives in the tail.
- Weekly figures look spectacular (+87% median at 50 bars) but n=44 spanning ~2 bull
  cycles. **Not trustworthy** — regime artifact, do not size off it.

Backtest caveats: survivorship bias (delisted pairs absent, which inflates results),
overlapping forward windows (effective sample ≪ n), no fees or slippage, and few
independent market regimes.

### Volume does not separate real crosses from fake ones

`score >= 3` can be met by trend + no-chop + momentum alone, so a graded cross may
have had **no volume expansion at all** — 7 of the 10 currently graded rows do not,
including both 1d `signal` rows. Splitting the graded population by the volume gate
and bootstrapping the gap in 20-bar median forward return (20k resamples):

| rule | n vol / no-vol | gap | P(gap ≤ 0) |
|---|---|---|---|
| 1d golden, Binance | 97 / 65 | +1.07pp | 0.38 |
| 1d golden, Binance (recent half) | 49 / 30 | +2.16pp | 0.28 |
| 4h death, Binance | 180 / 260 | +0.07pp | 0.53 |
| 4h death, **Hyperliquid** | 185 / 274 | **−0.53pp** | 0.70 |

The direction favours volume on Binance but **nothing here is significant**, and on
HL 4h the volume-confirmed crosses did *worse*. Volume is reported and shown on the
badge (`no vol`), but it is not treated as a hard requirement — the data does not
support that claim. The `vol_avg or 1` zero-volume fallback was checked and never
fires (0 of 2,399 crosses), so it is not fabricating confirmations.

### The graded rules are decaying — split-half edge, `P(edge ≤ 0)` bootstrapped

| rule | early half | late half (out-of-sample) |
|---|---|---|
| 1d golden, Binance | +6.27pp (P=0.11) | +4.16pp (P=0.11) |
| 4h death, Binance | **+2.60pp (P=0.000)** | +0.52pp (P=0.24) |
| 1d golden, **HL** | +11.99pp (P=0.10) | **−2.96pp (P=0.73)** |
| 4h death, **HL** | **+2.81pp (P=0.000)** | **−0.29pp (P=0.57)** |

The 4h `contrarian` rule — which is 8 of the 10 rows currently graded — was strongly
significant in the early half of history and is **indistinguishable from zero in the
recent half on both venues**. Treat it as decayed until re-benchmarked.

Because GRADED was fitted on Binance spot and does not survive out-of-sample on HL's
own history, **non-Binance venues no longer receive a verdict** — they grade as
`unvalidated venue`, the same withholding already applied to tokenized RWAs. Score
and gates are still reported.

## Signal vs noise (`python3 benchmark.py`)

Because raw crosses are weak, each cross is scored on **4 gates measurable at the
cross bar** (no look-ahead), over the deep history of 100 liquid coins:

| gate | passes when |
|---|---|
| `trend` | slow EMA slope (20 bars) agrees with the cross direction |
| `nochop` | zero prior crosses in the preceding 100 bars |
| `volexp` | quote volume at the cross ≥ 1.2× its 20-bar average |
| `momo` | fast EMA slope (20 bars) agrees with the cross direction |

AND-ing all gates is a trap — it leaves 1–3% of crosses (5–23 events), far too few to
trust. Instead crosses are bucketed by **score 0–4**, and a gate set only counts if
edge moves **monotonically** with score *and* holds in both halves of history.

**Results (median edge over base rate, 20 bars):**

| tf / side | score 0–1 | 2 | 3 | 4 | monotone? | verdict |
|---|---|---|---|---|---|---|
| 1d golden | — | +1.35 | **+3.99** | +7.66 | yes | **signal at ≥3** |
| 4h death | −1.22 | −0.26 | **+1.22** | +1.38 | yes | **contrarian at ≥3** |
| 4h golden | +0.52 | −0.18 | −0.15 | −0.51 | no | noise |
| 12h golden | −4.26 | +1.15 | −0.36 | −1.68 | no | noise |
| 12h death | −0.88 | +0.04 | −1.72 | −0.88 | no | noise |
| 1d death | −1.00 | −2.92 | −0.08 | −0.49 | no | noise |

- **`1d golden, score ≥3`** is the only genuine long signal: n=96, win 54.2% vs 44.8%
  base, +3.99pp median edge, out-of-sample **+3.01 (early) | +5.65 (late)**.
  Score 4 shows +7.66pp but is **−1.19 | +18.65** — the headline comes entirely from the
  late period, so ≥3 is the honest cut and score 4 is not promised as better.
- **`4h death, score ≥3`** is real but **inverted**: edge is *positive* after a death
  cross, i.e. a mean-reversion **long**, not a short (win 55.9% vs 45.7% base, OOS
  +2.52 | +0.57). Labelled `contrarian` so it can't be mistaken for a sell.
- Everything else is labelled **noise** — it did not beat the base rate out-of-sample.
- A cross older than **20 bars** is `expired`: 20 bars is the horizon the edge was
  measured over, so beyond it the grade would be an unearned claim.
- Only the `50/200` pair was benchmarked; `21/55` gets a score but grade `unvalidated`.

Honest caveat on multiple testing: 6 gates × 3 timeframes × 2 sides = 36 combinations
were examined, so some apparent winners are chance. The monotonicity requirement plus
the train/test split are the defence, not a proof — treat the 4h contrarian result as
weaker than the 1d signal.

## Hyperliquid specifics

- **HL backfills synthetic pre-listing candles and they must be trimmed.** BTC weekly
  reaches 2019 — four years before the exchange existed — and **ZEC 1d returned 704
  fabricated bars out of 1001**. They carry `n == 0` (zero trades) and would silently
  poison an EMA200. `hl_klines()` trims the leading zero-trade run. Interior zero-trade
  bars are kept: on an illiquid perp those are genuinely "no activity", and removing
  them would distort bar spacing. The payload reports `synthetic_series_trimmed`.
- **HL weekly EMA200 is impossible for every market** — the exchange has ~179 real
  weekly bars and 200 are needed. Shown as `·`, not faked.
- **Volume is 24h notional** (`dayNtlVlm`), not spot turnover — not directly comparable
  to the Binance column. HL liquidity is far more concentrated: of 177 non-delisted
  perps only 44 clear $1M/24h, vs 146 of 470 on Binance.
- HL's info endpoint is much tighter than Binance's. 4 concurrent workers produced ~4%
  transient `candleSnapshot` failures, so requests are globally paced to ~8/s with
  longer retry backoff. `candleSnapshot` caps at **5000 candles** per request.
- Coins HL has that Binance spot doesn't include **HYPE** itself (no Binance global
  pair — `HYPER*` there is Hyperlane, a different token).

### Cross-venue validation

Re-running `benchmark.py hyperliquid` is a stronger test than a train/test split, since
it's a different exchange with different flow:

| rule | Binance edge | HL edge | verdict |
|---|---|---|---|
| 1d golden, score ≥3 | +3.99pp (n=96) | +4.04pp (n=29) | consistent, HL underpowered |
| 4h death, score ≥3 | +1.22pp (n=340) | +1.47pp (n=364) | **replicates** |
| 4h golden / 12h / 1d death | noise | noise | noise on both |

The 4h contrarian effect replicates properly. The 1d signal is directionally identical
but HL has only 66 daily crosses in its whole history, so it neither confirms nor
contradicts. One ruleset is applied to both venues rather than fitting a separate HL
rule to n=29.

### Thin-history guard

A cross is graded `thin history` when fewer than **1.5× the slow period** of bars have
elapsed past the slow-EMA seed — the EMA itself isn't trustworthy there, so no verdict
is claimed. This is not HL-only: it demoted **BANK/USDT on Binance** (1d had 254 bars →
only 55 past the EMA200 seed) from a 4/4 "signal" to `thin history`.

## RWA / tokenized assets

Sector tags come from CoinGecko categories, cached 24h in `data/sectors.json`
(`python3 sectors.py` to refresh). Two separate things get conflated as "RWA", so the
dashboard splits them:

| tag | what it is | scannable? |
|---|---|---|
| `rwa` **+** `crypto` | RWA infrastructure tokens — ONDO, PLUME, CFG, LINK, XLM, INJ, ALGO, DIA | **yes, fully** — normal crypto with years of history, grades apply |
| `equity` | tokenized stocks/ETFs — Binance bStocks: TSLAB, QQQB, CRCLB, SOXLB, NVDAB… | **not yet** — see below |
| `commodity` | tokenized gold/silver — PAXG, XAUT | yes (history is long) |

Current scan: 498 crypto, 22 tokenized equity, 3 commodity; 52 RWA-tagged.

### Hyperliquid HIP-3 builder dexs — the real RWA venue

HL's **main** perp dex carries no RWA beyond crypto tokens (ONDO, LINK, INJ, XLM, PAXG).
The real-world markets live on **HIP-3 builder dexs**, queried by passing `dex` to
`metaAndAssetCtxs`. `python3 scanner.py --venue builder` scans them.

`{"type":"perpDexs"}` lists 9; only 4 currently have markets:

| dex | markets | 24h notional | what |
|---|---|---|---|
| **xyz** (trade.xyz) | 88 | **~$2.15B** | US + Asian equities, indices, commodities, FX, pre-IPO |
| mkts | 2 | $3.2M | US500, USTECH |
| hyna | 18 | $0.9M | crypto (BTC/ETH/HYPE) |
| para | 10 | $0.5M | US equities |

trade.xyz alone does **more 24h notional than all 470 Binance USDT spot pairs combined**
(~$5.4B across the whole book). It carries TSLA, NVDA, AAPL, GOOGL, META, MSFT, AMZN, AMD,
MU, INTC, ARM, ASML, AVGO, TSM, COIN, HOOD, PLTR, MSTR, GME, LLY, NFLX; SP500, XYZ100,
JP225, KR200; CL, BRENTOIL, GOLD, SILVER, NATGAS, COPPER, PLATINUM; JPY, EUR, GBP; Asian
names (SMSN, HYUNDAI, SOFTBANK, BABA, KIOXIA, CXMT, SKHX) and pre-IPO (SPCX, CRWV, ZHIPU,
MINIMAX).

Market names already carry their prefix (`xyz:CL`), which is also the `candleSnapshot`
coin id — no separate lookup needed.

**History is much deeper here than on Binance's bStocks:**

| market | 1h | 4h | 12h | 1d | EMA200 available |
|---|---|---|---|---|---|
| xyz:NVDA | 1001 | 1001 | 514 | 258 | 1h, 4h, 12h, **1d** |
| xyz:TSLA | 1001 | 1001 | 512 | 257 | 1h, 4h, 12h, **1d** |
| xyz:GOLD | 1001 | 1001 | 434 | 218 | 1h, 4h, 12h, **1d** |
| xyz:CL | 1001 | 1001 | 404 | 202 | 1h, 4h, 12h (1d is 3 bars short) |
| xyz:SP500 | 1001 | 786 | 262 | 131 | 1h, 4h, 12h |

So 12h is usable across most of trade.xyz today and the daily is arriving now. Grades are
still withheld (`unvalidated class`, plus `thin history` where warmup is short) — the
benchmark is crypto-only and these have nowhere near enough history to re-benchmark.

Asset class for builder markets is assigned from name lists in `scanner.py`, not
CoinGecko (CL and SP500 aren't listed coins). A `crypto_ref()` set built from the HL main
universe + Binance bases prevents the `hyna` dex's BTC/ETH/HYPE from being mislabelled
as equities.

### Binance tokenized equities can't be EMA-scanned yet

They listed Jun–Jul 2026, so they have **21–47 daily bars**. EMA200 needs 205:

| timeframe | bars available | EMA200 |
|---|---|---|
| 1w / 1d / 12h | 6 / 21–47 / 42–94 | **impossible** |
| 4h | ~130–280 | possible for 5 names, but warmup is ~83 bars vs 300 needed → `thin history` |
| 1h | ~500–1100 | works — but 1h is the timeframe measured **worse than the base rate** |

So the only timeframe with enough history is the one with negative measured edge. They
are scanned and displayed with honest labels, and will start grading themselves as
history accumulates — roughly **Feb 2027** before any gets a daily EMA200.

Two further cautions:

- **Grades are suppressed for every non-crypto class** (`unvalidated class`). The rules
  in `GRADED` were validated on crypto; a tokenized equity must not inherit them. Equity
  base rates and behaviour differ, and there is no history to re-benchmark on.
- **bStocks trade 24/7 on Binance while the underlying equities are closed.** Weekend
  candles carry real volume (QQQB traded 5,550 units on a Saturday) but have no NAV
  anchor, so weekend price action is exchange-internal drift mixed into the same EMA as
  weekday cash-market pricing.

Sector matching is by **uppercase ticker symbol**, so a collision between a CoinGecko
RWA entry and an unrelated Binance listing of the same ticker would mistag it.

## Known limits

- Weekly EMA200 is bounded by Binance's own listing history (ETHUSDT starts Aug
  2017 = 466 weekly bars). The ETH/SOL weekly crosses were verified robust to
  seeding method, but a fresh weekly cross can shift by ±1 bar.
- `eta_bars` is a linear extrapolation, not a forecast.
- A cross is lagging trend confirmation, not a trade signal.
