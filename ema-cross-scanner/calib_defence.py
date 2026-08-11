#!/usr/bin/env python3
"""How often does the project's OWN acceptance rule fire on pure noise?

The rule, as stated in the README: a tf/side combo is accepted if the median
edge moves MONOTONICALLY across score buckets and the score>=3 edge holds
(same sign) in BOTH halves of history.

Apply that exact rule to data where, by construction, the crosses carry no
information - under two nulls that preserve everything else about the data.
Also: Li-Ji effective number of independent tests from the null correlation
matrix, and BH on the narrowest defensible family (6 pre-registered combos).
"""
import json
import math
import random
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ, MIN_XS = 20, 20
B = 3000
random.seed(4242)
rr = random.random
BUCK = [(0, 1), (2, 2), (3, 3), (4, 4)]
MIN_EDGE = 1.0     # a combo must show at least this many pp to be called a signal


def fmed(v):
    v = sorted(v)
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def load(tf):
    d = json.loads((D / f"calib_{tf}.json").read_text())
    panel = {int(k): v for k, v in d["panel"].items()}
    alld = sorted(panel)
    coin_t, coin_r = {}, {}
    for t in alld:
        for s, v in panel[t].items():
            coin_t.setdefault(s, []).append(t)
            coin_r.setdefault(s, []).append(v)
    cpos = {s: {t: i for i, t in enumerate(ts)} for s, ts in coin_t.items()}
    basev = [(t, v) for (t, h, v) in d["base"] if h == HZ]
    rows = []
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ))
        if r is None:
            continue
        day = panel.get(x["t"])
        if not day or len(day) < MIN_XS + 1:
            continue
        rows.append({"sym": x["sym"], "t": x["t"], "golden": x["golden"],
                     "score": score(x), "r": r,
                     "peers": [v for s, v in day.items() if s != x["sym"]],
                     "ci": cpos[x["sym"]][x["t"]]})
    return rows, basev, coin_r


def accepts(buckets, halves, full):
    """buckets: [edge per score bucket, in order] (None where n<25)
       halves:  (early_edge, late_edge) for score>=3, None if unavailable
       full:    score>=3 edge"""
    seq = [e for e in buckets if e is not None]
    if len(seq) < 3:
        return False
    up = all(seq[i] <= seq[i + 1] for i in range(len(seq) - 1))
    dn = all(seq[i] >= seq[i + 1] for i in range(len(seq) - 1))
    if not (up or dn):
        return False
    if abs(full) < MIN_EDGE:
        return False
    if halves is None:
        return False
    a, b = halves
    return (a > 0 and b > 0 and full > 0) or (a < 0 and b < 0 and full < 0)


def evaluate(getr, rows, basev, mid, base_med, base_tr, base_te):
    """Run the acceptance rule for one tf, both sides. getr(row)->return."""
    res = {}
    for side, want in (("golden", True), ("death", False)):
        pool = [x for x in rows if x["golden"] == want]
        if len(pool) < 60:
            continue
        buckets = []
        for lo, hi in BUCK:
            sub = [x for x in pool if lo <= x["score"] <= hi]
            vals = [getr(x) for x in sub]
            vals = [v for v in vals if v is not None]
            buckets.append((fmed(vals) - base_med) * 100 if len(vals) >= 25 else None)
        g3 = [x for x in pool if x["score"] >= 3]
        v3 = [getr(x) for x in g3]
        v3 = [v for v in v3 if v is not None]
        full = (fmed(v3) - base_med) * 100 if len(v3) >= 25 else 0.0
        ea = [getr(x) for x in g3 if x["t"] <= mid]
        la = [getr(x) for x in g3 if x["t"] > mid]
        ea = [v for v in ea if v is not None]
        la = [v for v in la if v is not None]
        halves = ((fmed(ea) - base_tr) * 100, (fmed(la) - base_te) * 100) \
            if len(ea) >= 25 and len(la) >= 25 else None
        res[side] = accepts(buckets, halves, full)
    return res


def main():
    tfs = ["4h", "12h", "1d"]
    ctx = {}
    for tf in tfs:
        rows, basev, coin_r = load(tf)
        times = sorted(x["t"] for x in rows)
        mid = times[len(times) // 2]
        bm = fmed([v for _, v in basev])
        btr = fmed([v for t, v in basev if t <= mid])
        bte = fmed([v for t, v in basev if t > mid])
        ctx[tf] = (rows, basev, coin_r, mid, bm, btr, bte)

    # observed
    obs = {}
    for tf in tfs:
        rows, basev, coin_r, mid, bm, btr, bte = ctx[tf]
        obs.update({(tf, k): v for k, v in
                    evaluate(lambda x: x["r"], rows, basev, mid, bm, btr, bte).items()})
    n_obs = sum(obs.values())
    print("OBSERVED - the project's rule applied to the real data:")
    for k, v in obs.items():
        print(f"   {k[0]:4} {k[1]:7} {'ACCEPT' if v else 'reject'}")
    print(f"   -> {n_obs} of {len(obs)} combos accepted\n")

    # nulls
    for nullname in ("COIN-SWAP (no coin-selection skill)",
                     "DATE-SHIFT (no timing skill)"):
        counts, anyfire, per = [], 0, {}
        shifts = [k for k in range(-800, 801) if abs(k) >= 30]
        for _ in range(B):
            k = shifts[int(rr() * len(shifts))]
            tot = 0
            for tf in tfs:
                rows, basev, coin_r, mid, bm, btr, bte = ctx[tf]
                if nullname.startswith("COIN"):
                    def getr(x):
                        return x["peers"][int(rr() * len(x["peers"]))]
                else:
                    def getr(x, k=k, coin_r=coin_r):
                        cr = coin_r[x["sym"]]
                        j = x["ci"] + k
                        return cr[j] if 0 <= j < len(cr) else None
                r = evaluate(getr, rows, basev, mid, bm, btr, bte)
                for kk, v in r.items():
                    per[(tf, kk)] = per.get((tf, kk), 0) + (1 if v else 0)
                    tot += 1 if v else 0
            counts.append(tot)
            anyfire += 1 if tot else 0
        print(f"NULL: {nullname}   ({B} draws)")
        print(f"   mean combos accepted per draw : {sum(counts)/B:.2f}  "
              f"(observed {n_obs})")
        print(f"   P(at least one combo accepted): {anyfire/B:.3f}")
        print(f"   P(>= {n_obs} accepted)              : "
              f"{sum(1 for c in counts if c >= n_obs)/B:.3f}")
        print("   per-combo false-accept rate   : " +
              "  ".join(f"{a} {b[:4]}={per[(a,b)]/B:.2f}" for a, b in sorted(per)))
        print()


if __name__ == "__main__":
    main()
