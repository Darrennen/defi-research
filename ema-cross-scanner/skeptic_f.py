#!/usr/bin/env python3
"""ATTACK B: what does the date-shift null actually hold fixed, and is the
+-30..800 bar band the right one?

Three questions:
 1. Where is the null distribution CENTRED? If shifting these coins to other
    dates already produces a big positive pooled edge, the null is absorbing
    survivorship/regime, not just timing.
 2. Does the p-value depend on the shift band? A LOCAL band ("is the cross bar
    better than nearby bars for this coin") is the timing question a long-only
    entry rule actually poses; a +-800 bar band mostly asks "is 2023 better
    than 2021".
 3. A FULL randomisation null (random coin AND shifted date, clustering
    preserved) - the honest test of "would a long-only trader taking these
    alerts beat taking the same number of random long entries?"
"""
import json
import random
import statistics as st
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ, MIN_XS, B = 20, 20, 3000
random.seed(606)
rr = random.random


def fmed(v):
    v = sorted(v)
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def load(tf):
    d = json.loads((D / f"calib_{tf}.json").read_text())
    panel = {int(k): v for k, v in d["panel"].items()}
    alld = sorted(panel)
    didx = {t: i for i, t in enumerate(alld)}
    coin_t, coin_r = {}, {}
    for t in alld:
        for s, v in panel[t].items():
            coin_t.setdefault(s, []).append(t)
            coin_r.setdefault(s, []).append(v)
    cpos = {s: {t: i for i, t in enumerate(ts)} for s, ts in coin_t.items()}
    base_med = fmed([v for (_, h, v) in d["base"] if h == HZ])
    rows = []
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ))
        day = panel.get(x["t"])
        if r is None or not day or len(day) < MIN_XS + 1:
            continue
        rows.append({"sym": x["sym"], "t": x["t"], "golden": x["golden"],
                     "score": score(x), "r": r,
                     "ci": cpos[x["sym"]][x["t"]], "di": didx[x["t"]]})
    return rows, base_med, coin_r, panel, alld, didx


def main():
    for tf, side, want in (("1d", "golden", True), ("4h", "death", False)):
        rows, bm, coin_r, panel, alld, didx = load(tf)
        pool = [x for x in rows if x["golden"] == want]
        for lbl, sel in (("score>=3", lambda x: x["score"] >= 3),
                         ("ungated", lambda x: True)):
            sub = [x for x in pool if sel(x)]
            obs = (fmed([x["r"] for x in sub]) - bm) * 100
            print("=" * 86)
            print(f"{tf} {side} {lbl}  n={len(sub)}  observed POOLED edge {obs:+.2f}pp")
            print("=" * 86)
            print(f"  {'shift band (bars)':22} {'null med':>9} {'null 5%':>9} "
                  f"{'null 95%':>9} {'p(2-sided)':>11}")
            for lo, hi in ((30, 90), (30, 180), (30, 400), (30, 800), (200, 800)):
                shifts = [k for k in range(-hi, hi + 1) if lo <= abs(k) <= hi]
                nl = []
                for _ in range(B):
                    k = shifts[int(rr() * len(shifts))]
                    v = []
                    for x in sub:
                        cr = coin_r[x["sym"]]
                        j = x["ci"] + k
                        if 0 <= j < len(cr):
                            v.append(cr[j])
                    if len(v) >= 25:
                        nl.append((fmed(v) - bm) * 100)
                nl.sort()
                p = (1 + sum(1 for z in nl if abs(z) >= abs(obs))) / (len(nl) + 1)
                print(f"  +-{lo}..{hi:<18} {fmed(nl):>+9.2f} {nl[int(.05*len(nl))]:>+9.2f} "
                      f"{nl[int(.95*len(nl))]:>+9.2f} {p:>11.4f}")

            # FULL randomisation: random coin AND common date shift.
            shifts = [k for k in range(-800, 801) if abs(k) >= 30]
            nl = []
            for _ in range(B):
                k = shifts[int(rr() * len(shifts))]
                v = []
                for x in sub:
                    j = x["di"] + k
                    if 0 <= j < len(alld):
                        day = panel[alld[j]]
                        if len(day) >= MIN_XS:
                            ks = list(day.values())
                            v.append(ks[int(rr() * len(ks))])
                if len(v) >= 25:
                    nl.append((fmed(v) - bm) * 100)
            nl.sort()
            p = (1 + sum(1 for z in nl if abs(z) >= abs(obs))) / (len(nl) + 1)
            print(f"  FULL random entry      {fmed(nl):>+9.2f} {nl[int(.05*len(nl))]:>+9.2f} "
                  f"{nl[int(.95*len(nl))]:>+9.2f} {p:>11.4f}   "
                  f"<- 'same number of random long entries, same clustering'")
            print()


main()
