#!/usr/bin/env python3
"""ATTACK E: is 1d golden just 12-week cross-sectional momentum?

A golden cross is, mechanically, a trailing-momentum event. If the forward edge
is fully explained by "this coin is a high-momentum name today", the rule adds
nothing over a momentum rank and the kill is even more complete.

Control: for every cross, benchmark it not against ALL peers on that date but
against peers with SIMILAR trailing 12-week (84 bar) return - the nearest
MATCH_K peers in momentum rank. Anything left is not momentum.

Null: swap the cross's return for a random MOMENTUM-MATCHED peer on the same
date. That null holds date, market state AND momentum bucket fixed.
"""
import json
import math
import os
import random
import statistics as st
import sys
from bisect import bisect_left
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
DEEP = D / "deep"
HZ, LOOK, MIN_XS, MATCH_K, B = 20, 84, 20, 20, 4000
random.seed(20260812)
rr = random.random


def fmed(v):
    v = sorted(v)
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def wins(v, p=0.10):
    v = sorted(v)
    k = int(len(v) * p)
    if k:
        v = [v[k]] * k + v[k:len(v) - k] + [v[len(v) - 1 - k]] * k
    return st.mean(v)


def build_panels(tf, look):
    """date -> {sym: (fwd20, trailing-`look`-bar return)}"""
    syms = sorted({os.path.splitext(f)[0].rsplit("-", 1)[0]
                   for f in os.listdir(DEEP) if f.endswith(f"-{tf}.json")})
    panel = {}
    for s in syms:
        kl = json.loads((DEEP / f"{s}-{tf}.json").read_text())
        if len(kl) <= 260:
            continue
        ct = [int(k[6]) for k in kl]
        c = [float(k[4]) for k in kl]
        for i in range(look, len(c) - HZ):
            panel.setdefault(ct[i], {})[s] = (c[i + HZ] / c[i] - 1,
                                              c[i] / c[i - look] - 1)
    return panel


def main():
    tf = "1d"
    panel = build_panels(tf, LOOK)
    d = json.loads((D / f"calib_{tf}.json").read_text())

    rows = []
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ))
        day = panel.get(x["t"])
        if r is None or not day or len(day) < MIN_XS + 1:
            continue
        if x["sym"] not in day:
            continue
        me_mom = day[x["sym"]][1]
        peers = [(v[1], v[0]) for s, v in day.items() if s != x["sym"]]
        if len(peers) < MIN_XS:
            continue
        peers.sort()
        moms = [p[0] for p in peers]
        # momentum percentile of the cross coin among its peers
        pct = bisect_left(moms, me_mom) / len(moms) * 100
        # nearest MATCH_K peers by momentum
        j = bisect_left(moms, me_mom)
        lo, hi = j, j
        sel = []
        while len(sel) < min(MATCH_K, len(peers)):
            cl = abs(moms[lo - 1] - me_mom) if lo > 0 else 1e18
            ch = abs(moms[hi] - me_mom) if hi < len(peers) else 1e18
            if cl <= ch:
                lo -= 1
                sel.append(peers[lo])
            else:
                sel.append(peers[hi])
                hi += 1
        rows.append({"sym": x["sym"], "t": x["t"], "golden": x["golden"],
                     "score": score(x), "r": r, "mom": me_mom, "pct": pct,
                     "allpeer": [p[1] for p in peers],
                     "mpeer": [p[1] for p in sel],
                     "mmom": [p[0] for p in sel]})

    for side, want in (("golden", True), ("death", False)):
        pool = [x for x in rows if x["golden"] == want]
        for lbl, sel in (("score>=3", lambda x: x["score"] >= 3),
                         ("ungated", lambda x: True)):
            sub = [x for x in pool if sel(x)]
            if len(sub) < 25:
                continue
            print("=" * 88)
            print(f"1d {side} {lbl}   n={len(sub)}")
            print("=" * 88)
            print(f"  trailing 12-week return of the crossing coin: median "
                  f"{fmed([x['mom'] for x in sub])*100:+.1f}%   "
                  f"peer-rank percentile: mean {st.mean([x['pct'] for x in sub]):.1f} "
                  f"median {fmed([x['pct'] for x in sub]):.1f}  (50 = no momentum tilt)")
            mm = fmed([fmed(x["mmom"]) for x in sub])
            print(f"  matched-peer trailing 12-week return: median {mm*100:+.1f}% "
                  f"(match quality)")
            for bench, tag in (("allpeer", "ALL-peer relative"),
                               ("mpeer", "MOMENTUM-MATCHED relative")):
                dif = [x["r"] - fmed(x[bench]) for x in sub]
                lg = [math.log(1 + x["r"]) - math.log(1 + fmed(x[bench]))
                      for x in sub]
                nm, nw, nl = [], [], []
                for _ in range(B):
                    pk = [x[bench][int(rr() * len(x[bench]))] for x in sub]
                    dd = [p - fmed(x[bench]) for p, x in zip(pk, sub)]
                    ll = [math.log(1 + p) - math.log(1 + fmed(x[bench]))
                          for p, x in zip(pk, sub)]
                    nm.append(fmed(dd))
                    nw.append(wins(dd))
                    nl.append(st.mean(ll))

                def pv(nl_, o):
                    return (1 + sum(1 for z in nl_ if abs(z) >= abs(o))) / (B + 1)
                print(f"  {tag:28} median {fmed(dif)*100:+6.2f}pp (p={pv(nm, fmed(dif)):.4f})"
                      f"  wins-mean {wins(dif)*100:+6.2f}pp (p={pv(nw, wins(dif)):.4f})"
                      f"  log-mean {st.mean(lg)*100:+6.2f}pp (p={pv(nl, st.mean(lg)):.4f})")
            print()


main()
