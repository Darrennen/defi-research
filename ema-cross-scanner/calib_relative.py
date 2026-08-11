#!/usr/bin/env python3
"""Is the measured 'edge' cross-selection skill, or just market timing?

benchmark.py compares a cross's forward return to a POOLED ALL-TIME base rate
across every coin and every bar. Crosses cluster in time (they are triggered by
the same market-wide moves), so that comparison rewards a rule for firing in a
bull tape even if it picks no better than a coin flip among coins.

Here every cross is instead compared to the CONTEMPORANEOUS cross-section: the
median 20-bar forward return of all other coins over the exact same bars.
"""
import json
import statistics
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ = 20
MIN_XS = 20      # need this many coins alive on a date to form a market median


def analyse(tf):
    d = json.loads((D / f"calib_{tf}.json").read_text())
    panel = d["panel"]
    base_all = [v for (_, h, v) in d["base"] if h == HZ]
    base_med = statistics.median(base_all)
    rows = []
    dropped = 0
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ), x["fwd"].get(HZ))
        if r is None:
            continue
        day = panel.get(str(x["t"]))
        if not day or len(day) < MIN_XS:
            dropped += 1
            continue
        others = [v for s, v in day.items() if s != x["sym"]]
        if len(others) < MIN_XS:
            dropped += 1
            continue
        mkt = statistics.median(others)
        rows.append({"sym": x["sym"], "t": x["t"], "golden": x["golden"],
                     "score": score(x), "r": r, "mkt": mkt, "rel": r - mkt,
                     "nxs": len(others)})
    return rows, base_med, dropped


print(f"{'combo':22} {'bucket':9} {'n':>5} "
      f"{'raw med':>8} {'POOLED':>8} | {'mkt med':>8} {'RELATIVE':>9} {'relwin%':>8}")
print("-" * 92)
out = {}
for tf in ["4h", "12h", "1d"]:
    rows, base_med, dropped = analyse(tf)
    for side, want in (("golden", True), ("death", False)):
        pool = [x for x in rows if x["golden"] == want]
        for lbl, sel in (("ALL", lambda x: True),
                         ("score>=3", lambda x: x["score"] >= 3),
                         ("score 3", lambda x: x["score"] == 3),
                         ("score 4", lambda x: x["score"] == 4)):
            sub = [x for x in pool if sel(x)]
            if len(sub) < 25:
                continue
            r = [x["r"] for x in sub]
            rel = [x["rel"] for x in sub]
            mkt = [x["mkt"] for x in sub]
            print(f"{tf+' '+side:22} {lbl:9} {len(sub):>5} "
                  f"{statistics.median(r)*100:>+8.2f} "
                  f"{(statistics.median(r)-base_med)*100:>+8.2f} | "
                  f"{statistics.median(mkt)*100:>+8.2f} "
                  f"{statistics.median(rel)*100:>+9.2f} "
                  f"{sum(1 for v in rel if v>0)/len(rel)*100:>7.1f}%")
            out[(tf, side, lbl)] = rel
    print(f"{'':22} (pooled base median {base_med*100:+.2f}%, "
          f"{dropped} crosses dropped for thin cross-section)")
    print("-" * 92)
