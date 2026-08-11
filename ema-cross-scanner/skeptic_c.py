#!/usr/bin/env python3
"""ATTACK on claim 2 (multiplicity): redo Westfall-Young over the FULL 35-test
family, but

  (a) with a SHARED coin-swap draw, so nested buckets keep their real
      correlation (calib_infer2 re-draws peers independently inside each test,
      which breaks the dependence WY is supposed to exploit and inflates the
      max-statistic); calib_effm already showed max pairwise corr 0.862.
  (b) under the winsorised-mean and log-mean relative statistics as well as the
      reviewer's median.

If 1d golden survives FWER at m=35 with correct dependence, the multiplicity
kill is statistic-specific, not structural.
"""
import json
import math
import random
import statistics as st
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ, MIN_XS, B = 20, 20, 4000
random.seed(777)
rr = random.random
BUCKETS = [("0-1", 0, 1), ("2", 2, 2), ("3", 3, 3), ("4", 4, 4),
           (">=3", 3, 4), ("ALL", 0, 4)]


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
        rows.append({"golden": x["golden"], "score": score(x), "r": r,
                     "mkt": fmed(peers), "peers": peers})
    return rows


allrows, fam = [], []
for tf in ["4h", "12h", "1d"]:
    rows = load(tf)
    off = len(allrows)
    allrows += rows
    for side, want in (("golden", True), ("death", False)):
        idx = [off + i for i, x in enumerate(rows) if x["golden"] == want]
        for lbl, lo, hi in BUCKETS:
            sub = [i for i in idx if lo <= allrows[i]["score"] <= hi]
            if len(sub) >= 25:
                fam.append((f"{tf} {side} s{lbl}", sub))

print(f"family m = {len(fam)}, shared coin-swap draw, B={B}\n")

STATS = {
    "medrel": fmed,
    "winrel": wins,
    "logrel": None,        # handled separately (needs the pair, not the diff)
}


def stat(name, vals, logs):
    if name == "medrel":
        return fmed(vals) * 100
    if name == "winrel":
        return wins(vals) * 100
    return st.mean(logs) * 100


obs_diff = [x["r"] - x["mkt"] for x in allrows]
obs_log = [math.log(1 + x["r"]) - math.log(1 + x["mkt"]) for x in allrows]
obs = {n: {} for n in STATS}
for n in STATS:
    for lbl, sub in fam:
        obs[n][lbl] = stat(n, [obs_diff[j] for j in sub],
                           [obs_log[j] for j in sub])

nulls = {n: {lbl: [] for lbl, _ in fam} for n in STATS}
maxes = {n: [] for n in STATS}
for _ in range(B):
    picks = [x["peers"][int(rr() * len(x["peers"]))] for x in allrows]
    sd = [p - x["mkt"] for p, x in zip(picks, allrows)]
    sl = [math.log(1 + p) - math.log(1 + x["mkt"])
          for p, x in zip(picks, allrows)]
    for n in STATS:
        mx = 0.0
        for lbl, sub in fam:
            z = stat(n, [sd[j] for j in sub], [sl[j] for j in sub])
            nulls[n][lbl].append(z)
            mx = max(mx, abs(z))
        maxes[n].append(mx)

for n in STATS:
    print(f"--- statistic {n} ---")
    rows_out = []
    for lbl, sub in fam:
        o = obs[n][lbl]
        nl = nulls[n][lbl]
        p = (1 + sum(1 for z in nl if abs(z) >= abs(o))) / (B + 1)
        f = (1 + sum(1 for z in maxes[n] if z >= abs(o))) / (B + 1)
        rows_out.append((p, lbl, len(sub), o, f))
    rows_out.sort()
    print(f"  {'test':18} {'n':>4} {'obs':>8} {'p':>7} {'pFWER(m=35)':>12}")
    for p, lbl, ns, o, f in rows_out[:6]:
        print(f"  {lbl:18} {ns:>4} {o:>+8.2f} {p:>7.4f} {f:>12.4f}")
    m = len(rows_out)
    k = 0
    for rank, (p, *_ ) in enumerate(rows_out, 1):
        if p <= 0.05 * rank / m:
            k = rank
    print(f"  Benjamini-Hochberg FDR 5% (m={m}): {k} discoveries" +
          ("  -> " + ", ".join(r[1] for r in rows_out[:k]) if k else ""))
    print()
