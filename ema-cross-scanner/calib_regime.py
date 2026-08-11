#!/usr/bin/env python3
"""Two things the alert spec needs: a market-regime filter, and alert volume.

Regime is BTC's own 1d close vs its 1d EMA200, evaluated AT the cross bar - one
pre-specified, economically motivated filter, not another mined gate.
"""
import json
import statistics
import sys
from bisect import bisect_right
from datetime import datetime, timezone
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402
from scanner import ema                                              # noqa: E402

D = Path(__file__).parent / "data"
HZ = 20

btc = json.loads((D / "deep" / "BTCUSDT-1d.json").read_text())
bt = [int(k[6]) for k in btc]
bc = [float(k[4]) for k in btc]
be = ema(bc, 200)
bull_t = [t for t, c, e in zip(bt, bc, be) if e is not None]
bull_v = [c > e for c, e in zip(bc, be) if e is not None]


def btc_bull(when):
    j = bisect_right(bull_t, when) - 1
    return bull_v[j] if j >= 0 else None


def med(v):
    return statistics.median(v) if v else float("nan")


def rows_for(tf):
    d = json.loads((D / f"calib_{tf}.json").read_text())
    panel = {int(k): v for k, v in d["panel"].items()}
    out = []
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ))
        if r is None:
            continue
        others = [v for s, v in panel.get(x["t"], {}).items() if s != x["sym"]]
        if len(others) < 20:
            continue
        out.append({**x, "r": r, "rel": r - statistics.median(others),
                    "score": score(x), "bull": btc_bull(x["t"])})
    return out


print("=" * 96)
print("BTC 1d close vs BTC 1d EMA200 at the cross bar")
print("=" * 96)
print(f"{'rule':28} {'regime':10} {'n':>5} {'raw med':>9} {'RELATIVE':>9} "
      f"{'win%':>6} {'p25':>8} {'p75':>8}")
for tf, want, ms, lbl in (("1d", True, 3, "1d golden score>=3"),
                          ("1d", True, 0, "1d golden ungated"),
                          ("4h", False, 3, "4h death score>=3")):
    rr = [x for x in rows_for(tf)
          if x["golden"] == want and x["score"] >= ms]
    for reg, val in (("BTC bull", True), ("BTC bear", False)):
        sub = [x for x in rr if x["bull"] is val]
        if len(sub) < 15:
            print(f"{lbl:28} {reg:10} n={len(sub)} too few")
            continue
        r = sorted(x["r"] for x in sub)
        print(f"{lbl:28} {reg:10} {len(sub):>5} {med(r)*100:>+9.2f} "
              f"{med([x['rel'] for x in sub])*100:>+9.2f} "
              f"{sum(1 for v in r if v>0)/len(r)*100:>5.1f}% "
              f"{r[len(r)//4]*100:>+8.1f} {r[3*len(r)//4]*100:>+8.1f}")

print("\n" + "=" * 96)
print("ALERT VOLUME - 1d golden score>=3, over 80 benchmarked coins")
print("=" * 96)
rr = [x for x in rows_for("1d") if x["golden"] and x["score"] >= 3]
days = {}
for x in rr:
    days.setdefault(datetime.fromtimestamp(x["t"] / 1000, timezone.utc).date(), []).append(x)
span = (max(days) - min(days)).days / 365.25
print(f"  {len(rr)} crosses / {span:.1f} years over 80 coins = "
       f"{len(rr)/span:.1f} per year")
hist = {}
for d2, v in days.items():
    hist[len(v)] = hist.get(len(v), 0) + 1
print(f"  days with a cross: {len(days)};  same-day count histogram: "
      f"{dict(sorted(hist.items()))}")
print(f"  scanner scans ~470 Binance USDT pairs, benchmark used 80 -> expect "
      f"roughly {len(rr)/span*470/80:.0f} alerts/yr ({len(rr)/span*470/80/52:.1f}/wk) "
      f"if the whole book is alerted, heavily clustered on the same days")
# concurrency: how many crosses are live inside any 20-day window
ts = sorted(x["t"] for x in rr)
mx = 0
for i, t in enumerate(ts):
    mx = max(mx, sum(1 for u in ts if t <= u < t + 20 * 86400_000))
print(f"  max concurrent open positions in any 20-day window (80 coins): {mx}"
      f"  -> ~{mx*470/80:.0f} scaled to the full book")
