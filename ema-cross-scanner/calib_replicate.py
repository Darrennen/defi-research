#!/usr/bin/env python3
"""Step 1: reproduce benchmark.py's headline score-bucket table from the cache,
so every later test is known to sit on the same numbers."""
import json
import statistics
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ = 20


def load(tf):
    return json.loads((D / f"calib_{tf}.json").read_text())


def edge(sample, base, hz=HZ):
    r = [x["fwd"][str(hz)] if str(hz) in x["fwd"] else x["fwd"].get(hz)
         for x in sample]
    r = [v for v in r if v is not None]
    if len(r) < 25:
        return None
    med = statistics.median(r)
    win = sum(1 for v in r if v > 0) / len(r) * 100
    return {"n": len(r), "med": med * 100, "mean": statistics.mean(r) * 100,
            "win": win, "edge": (med - statistics.median(base)) * 100,
            "win_edge": win - sum(1 for v in base if v > 0) / len(base) * 100}


for tf in ["4h", "12h", "1d"]:
    d = load(tf)
    allx = d["crosses"]
    base_all = [v for (_, h, v) in d["base"] if h == HZ]
    times = sorted(x["t"] for x in allx)
    mid = times[len(times) // 2]
    base_tr = [v for (t, h, v) in d["base"] if h == HZ and t <= mid]
    base_te = [v for (t, h, v) in d["base"] if h == HZ and t > mid]
    for side, want in (("GOLDEN", True), ("DEATH", False)):
        pool = [x for x in allx if x["golden"] == want]
        if len(pool) < 60:
            continue
        print(f"\n=== {tf} {side}  crosses={len(pool)}  split={mid}")
        print(f"  {'bucket':10} {'n':>5} {'win%':>6} {'med':>8} {'mean':>8} "
              f"{'EDGE':>8} {'winEdge':>8}   early | late")
        e = edge(pool, base_all)
        if e:
            print(f"  {'ALL':10} {e['n']:>5} {e['win']:>6.1f} {e['med']:>+8.2f} "
                  f"{e['mean']:>+8.2f} {e['edge']:>+8.2f} {e['win_edge']:>+8.1f}")
        for lo, hi in ((0, 1), (2, 2), (3, 3), (4, 4), (3, 4)):
            sub = [x for x in pool if lo <= score(x) <= hi]
            e = edge(sub, base_all)
            tr = edge([x for x in sub if x["t"] <= mid], base_tr)
            te = edge([x for x in sub if x["t"] > mid], base_te)
            lbl = f"score {lo}" + ("" if lo == hi else f"-{hi}")
            if not e:
                print(f"  {lbl:10} n={len(sub)} too few")
                continue
            oos = (f"{tr['edge']:>+7.2f} | {te['edge']:>+7.2f}"
                   if tr and te else "  insufficient")
            print(f"  {lbl:10} {e['n']:>5} {e['win']:>6.1f} {e['med']:>+8.2f} "
                  f"{e['mean']:>+8.2f} {e['edge']:>+8.2f} {e['win_edge']:>+8.1f}   {oos}")
