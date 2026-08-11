#!/usr/bin/env python3
"""Economics of the two candidate rules: clustering, stability, fat tails,
liquidity dependence and net-of-cost P&L. All figures from the cached history."""
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ = 20
EQUITY = {"CRCLBUSDT", "TSLABUSDT", "QQQBUSDT", "SOXLBUSDT", "SPCXBUSDT",
          "SNDKBUSDT", "SKHYBUSDT", "MUBUSDT", "DRAMBUSDT"}
PEG = {"BFUSDUSDT", "XAUTUSDT", "PAXGUSDT"}


def load(tf):
    d = json.loads((D / f"calib_{tf}.json").read_text())
    panel = {int(k): v for k, v in d["panel"].items()}
    rows = []
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ))
        if r is None:
            continue
        day = panel.get(x["t"], {})
        others = [v for s, v in day.items() if s != x["sym"]]
        rows.append({"sym": x["sym"], "t": x["t"], "golden": x["golden"],
                     "score": score(x), "r": r, "vol": x["vol_avg"],
                     "mkt": statistics.median(others) if len(others) >= 20 else None})
    base = [v for (_, h, v) in d["base"] if h == HZ]
    return rows, base, panel


def ymd(t):
    return datetime.fromtimestamp(t / 1000, timezone.utc)


def sel(rows, golden, minscore):
    return [x for x in rows if x["golden"] == golden and x["score"] >= minscore]


def report(name, sub, base, panel):
    r = sorted(x["r"] for x in sub)
    n = len(r)
    print(f"\n{'='*78}\n{name}   n={n}\n{'='*78}")
    # clustering
    dates = sorted({x["t"] for x in sub})
    alld = sorted(panel)
    idx = {t: i for i, t in enumerate(alld)}
    blocks = {idx[x["t"]] // HZ for x in sub}
    biggest = max(sum(1 for x in sub if x["t"] == t) for t in dates)
    print(f"  distinct dates {len(dates)} | non-overlapping {HZ}-bar blocks "
          f"{len(blocks)} | most crosses on one bar {biggest}")
    print(f"  effective independent events ~= {len(blocks)} "
          f"(n/blocks = {n/len(blocks):.1f} crosses per block)")
    print(f"  span {ymd(dates[0]):%Y-%m-%d} .. {ymd(dates[-1]):%Y-%m-%d}")
    # composition
    eq = sum(1 for x in sub if x["sym"] in EQUITY)
    pg = sum(1 for x in sub if x["sym"] in PEG)
    print(f"  non-crypto contamination: {eq} tokenized-equity, {pg} pegged/metal crosses")
    # distribution
    q = lambda p: r[min(int(p * n), n - 1)]
    print(f"  quantiles  p05 {q(.05)*100:+.1f}%  p25 {q(.25)*100:+.1f}%  "
          f"med {statistics.median(r)*100:+.2f}%  p75 {q(.75)*100:+.1f}%  "
          f"p95 {q(.95)*100:+.1f}%   mean {statistics.mean(r)*100:+.2f}%")
    top = r[-max(1, n // 20):]
    print(f"  fat tail: top 5% of trades ({len(top)}) contribute "
          f"{sum(top)/sum(r)*100 if sum(r) else float('nan'):.0f}% of total return; "
          f"mean excl. top 10% = {statistics.mean(r[:-max(1,n//10)])*100:+.2f}%")
    print(f"  win rate {sum(1 for v in r if v>0)/n*100:.1f}%")
    # net of cost
    print("  net MEDIAN / net MEAN after round-trip cost:")
    for c in (0, 20, 40, 60, 100):
        print(f"     {c:>3}bp: median {(statistics.median(r)-c/1e4)*100:+.2f}%   "
              f"mean {(statistics.mean(r)-c/1e4)*100:+.2f}%")
    # liquidity buckets (20-bar avg quote volume at the cross bar, per bar)
    lv = sorted(sub, key=lambda x: x["vol"])
    print("  by liquidity at the cross (20-bar avg quote volume per bar):")
    for lo, hi, lbl in ((0, .33, "bottom third"), (.33, .66, "middle"),
                        (.66, 1.0, "top third")):
        g = lv[int(lo * n):int(hi * n)]
        if len(g) < 15:
            continue
        rr = [x["r"] for x in g]
        rel = [x["r"] - x["mkt"] for x in g if x["mkt"] is not None]
        print(f"     {lbl:13} n={len(g):>4} vol/bar ${statistics.median([x['vol'] for x in g]):>12,.0f}"
              f"   raw med {statistics.median(rr)*100:>+7.2f}%"
              f"   rel med {statistics.median(rel)*100:>+7.2f}%")
    # year by year
    print("  by year (raw median | market median that year at those dates | relative):")
    yrs = {}
    for x in sub:
        yrs.setdefault(ymd(x["t"]).year, []).append(x)
    for y in sorted(yrs):
        g = yrs[y]
        rel = [x["r"] - x["mkt"] for x in g if x["mkt"] is not None]
        if len(g) < 5:
            print(f"     {y}  n={len(g):>3}  (too few)")
            continue
        print(f"     {y}  n={len(g):>3}  raw {statistics.median([x['r'] for x in g])*100:>+7.2f}%"
              f"   mkt {statistics.median([x['mkt'] for x in g if x['mkt'] is not None])*100:>+7.2f}%"
              f"   rel {statistics.median(rel)*100:>+7.2f}%" if rel else "")


for tf, golden, ms, label in (("1d", True, 3, "1d GOLDEN score>=3"),
                              ("1d", True, 0, "1d GOLDEN ungated (control)"),
                              ("4h", False, 3, "4h DEATH score>=3"),
                              ("4h", False, 0, "4h DEATH ungated (control)")):
    rows, base, panel = load(tf)
    report(label, sel(rows, golden, ms), base, panel)
