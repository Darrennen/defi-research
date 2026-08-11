#!/usr/bin/env python3
"""ATTACK D: "the score gate adds nothing" rests on P(gap<=0)=0.341 for a
+1.62pp gap between score>=3 (n=144) and score<3 (n=43).

A failure to reject is only informative if the test could have rejected.
Measure the power of that exact test at the observed effect size, and find the
gap size the test could actually detect at 80% power.
"""
import json
import random
import statistics as st
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ, MIN_XS = 20, 20
random.seed(31337)
rr = random.random
OUTER, INNER = 600, 800


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


def load(tf):
    d = json.loads((D / f"calib_{tf}.json").read_text())
    panel = {int(k): v for k, v in d["panel"].items()}
    rows = []
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ))
        day = panel.get(x["t"])
        if r is None or not day or len(day) < MIN_XS + 1:
            continue
        peers = [v for s, v in day.items() if s != x["sym"]]
        if len(peers) < MIN_XS:
            continue
        rows.append({"golden": x["golden"], "score": score(x),
                     "rel": r - fmed(peers)})
    return rows


def gap_test(a, b, statf, inner=INNER):
    """P(gap <= 0) by bootstrap, exactly as calib_robust does it."""
    na, nb = len(a), len(b)
    cnt = 0
    for _ in range(inner):
        ra = [a[int(rr() * na)] for _ in range(na)]
        rb = [b[int(rr() * nb)] for _ in range(nb)]
        if statf(ra) - statf(rb) <= 0:
            cnt += 1
    return cnt / inner


def main():
    rows = load("1d")
    pool = [x for x in rows if x["golden"]]
    hi = [x["rel"] for x in pool if x["score"] >= 3]
    lo = [x["rel"] for x in pool if x["score"] < 3]
    print(f"1d golden: score>=3 n={len(hi)} rel-median {fmed(hi)*100:+.2f}pp | "
          f"score<3 n={len(lo)} rel-median {fmed(lo)*100:+.2f}pp | "
          f"gap {(fmed(hi)-fmed(lo))*100:+.2f}pp")

    for sname, statf in (("median", fmed), ("wins-mean", wins)):
        obs_gap = statf(hi) - statf(lo)
        p_obs = gap_test(hi, lo, statf, 4000)
        print(f"\n--- statistic: {sname} | observed gap {obs_gap*100:+.2f}pp, "
              f"P(gap<=0)={p_obs:.3f}")
        # POWER at the observed effect: resample both groups from their own
        # observed distributions (so the true gap equals the observed gap) and
        # re-run the identical test.
        rej = 0
        for _ in range(OUTER):
            a = [hi[int(rr() * len(hi))] for _ in range(len(hi))]
            b = [lo[int(rr() * len(lo))] for _ in range(len(lo))]
            if gap_test(a, b, statf) <= 0.05:
                rej += 1
        print(f"    power at the OBSERVED gap, alpha=0.05 one-sided : "
              f"{rej/OUTER:.2f}")
        # Minimum detectable gap: shift the score<3 sample DOWN until 80% power.
        for shift in (0.02, 0.04, 0.06, 0.08, 0.12, 0.16):
            rej = 0
            for _ in range(OUTER // 2):
                a = [hi[int(rr() * len(hi))] for _ in range(len(hi))]
                b = [lo[int(rr() * len(lo))] - shift for _ in range(len(lo))]
                if gap_test(a, b, statf, 400) <= 0.05:
                    rej += 1
            tg = (statf(hi) - (statf(lo) - shift)) * 100
            print(f"    true gap {tg:>+6.2f}pp -> power {rej/(OUTER//2):.2f}")


main()
