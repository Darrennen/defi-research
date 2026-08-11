#!/usr/bin/env python3
"""What liquidity range was the 1d rule actually measured over, and what does
the one candidate configuration look like? (Post-hoc config - reported with
that caveat, not as a validated rule.)"""
import json
import statistics
import sys
from bisect import bisect_right
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
bull_t = [t for t, e in zip(bt, be) if e is not None]
bull_v = [c > e for c, e in zip(bc, be) if e is not None]


def bull(w):
    j = bisect_right(bull_t, w) - 1
    return bull_v[j] if j >= 0 else None


d = json.loads((D / "calib_1d.json").read_text())
panel = {int(k): v for k, v in d["panel"].items()}
rows = []
for x in d["crosses"]:
    r = x["fwd"].get(str(HZ))
    if r is None:
        continue
    others = [v for s, v in panel.get(x["t"], {}).items() if s != x["sym"]]
    if len(others) < 20:
        continue
    rows.append({**x, "r": r, "rel": r - statistics.median(others),
                 "score": score(x), "bull": bull(x["t"])})
g = [x for x in rows if x["golden"]]
v = sorted(x["vol_avg"] for x in g)
n = len(v)
print(f"1d golden crosses in the benchmark: n={n}")
print(f"  daily quote volume at the cross: p05 ${v[n//20]:,.0f}  p25 ${v[n//4]:,.0f}  "
      f"median ${statistics.median(v):,.0f}  p95 ${v[int(n*.95)]:,.0f}")
for t in (1e6, 3e6, 1e7):
    print(f"  crosses below ${t/1e6:.0f}M/day: {sum(1 for z in v if z < t)} "
          f"({sum(1 for z in v if z < t)/n*100:.0f}%)")
print("  -> the rule was never measured on sub-$1M/day pairs, yet the scanner "
      "grades them\n")


def show(lbl, sub):
    if len(sub) < 15:
        print(f"  {lbl:44} n={len(sub)} too few")
        return
    r = sorted(x["r"] for x in sub)
    rel = [x["rel"] for x in sub]
    print(f"  {lbl:44} n={len(sub):>4}  raw med {statistics.median(r)*100:>+6.2f}%"
          f"  rel {statistics.median(rel)*100:>+6.2f}pp"
          f"  win {sum(1 for z in r if z>0)/len(r)*100:>4.1f}%"
          f"  mean {statistics.mean(r)*100:>+6.2f}%"
          f"  p05 {r[len(r)//20]*100:>+6.1f}%")


print("Candidate configurations (POST-HOC - each extra filter is another test):")
show("ungated", g)
show("ungated + BTC bull", [x for x in g if x["bull"]])
show("ungated + BTC bull + >=$3M/day", [x for x in g if x["bull"] and x["vol_avg"] >= 3e6])
show("score>=3 + BTC bull + >=$3M/day",
     [x for x in g if x["bull"] and x["vol_avg"] >= 3e6 and x["score"] >= 3])
show("score>=3 + BTC bull + >=$10M/day",
     [x for x in g if x["bull"] and x["vol_avg"] >= 1e7 and x["score"] >= 3])
