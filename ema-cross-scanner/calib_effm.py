#!/usr/bin/env python3
"""Effective number of independent tests in the search family.

The 35 score-bucket tests are not independent: buckets are nested (>=3 contains
3 and 4), timeframes overlap the same bars, and the same coins/dates recur. Draw
the test statistics jointly under the coin-swap null, take the correlation
matrix of those statistics, and reduce it with Li & Ji (2005): m_eff = sum over
eigenvalues of [I(l>=1) + (l - floor(l))]. Eigenvalues by cyclic Jacobi.
"""
import json
import math
import random
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ, MIN_XS, B = 20, 20, 3000
random.seed(99)
rr = random.random
BUCKETS = [("0-1", 0, 1), ("2", 2, 2), ("3", 3, 3), ("4", 4, 4), (">=3", 3, 4),
           ("ALL", 0, 4)]


def fmed(v):
    v = sorted(v); n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


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
        rows.append({"golden": x["golden"], "score": score(x),
                     "mkt": fmed(peers), "peers": peers})
    return rows


def jacobi(a, iters=100):
    n = len(a)
    a = [row[:] for row in a]
    for _ in range(iters):
        off = max((abs(a[i][j]), i, j) for i in range(n) for j in range(i + 1, n))
        if off[0] < 1e-10:
            break
        _, p, q = off
        if abs(a[p][p] - a[q][q]) < 1e-15:
            th = math.pi / 4
        else:
            th = 0.5 * math.atan2(2 * a[p][q], a[p][p] - a[q][q])
        c, s = math.cos(th), math.sin(th)
        for k in range(n):
            akp, akq = a[k][p], a[k][q]
            a[k][p], a[k][q] = c * akp + s * akq, -s * akp + c * akq
        for k in range(n):
            apk, aqk = a[p][k], a[q][k]
            a[p][k], a[q][k] = c * apk + s * aqk, -s * apk + c * aqk
    return sorted((a[i][i] for i in range(n)), reverse=True)


# One shared row pool: the SAME random draw feeds every test, so nested buckets
# (s3 inside s>=3 inside sALL) show their true correlation.
allrows, fam = [], []
for tf in ["4h", "12h", "1d"]:
    rows = load(tf)
    off = len(allrows)
    allrows += rows
    for side, want in (("g", True), ("d", False)):
        idx = [off + i for i, x in enumerate(rows) if x["golden"] == want]
        for lbl, lo, hi in BUCKETS:
            sub = [i for i in idx if lo <= allrows[i]["score"] <= hi]
            if len(sub) >= 25:
                fam.append((f"{tf}{side}{lbl}", sub))

draws = [[] for _ in fam]
for _ in range(B):
    shared = [x["peers"][int(rr() * len(x["peers"]))] - x["mkt"] for x in allrows]
    for i, (_, sub) in enumerate(fam):
        draws[i].append(fmed([shared[j] for j in sub]))

m = len(fam)
mu = [sum(d) / B for d in draws]
sd = [math.sqrt(sum((v - mu[i]) ** 2 for v in draws[i]) / B) for i in range(m)]
C = [[0.0] * m for _ in range(m)]
for i in range(m):
    for j in range(i, m):
        cov = sum((draws[i][k] - mu[i]) * (draws[j][k] - mu[j]) for k in range(B)) / B
        C[i][j] = C[j][i] = cov / (sd[i] * sd[j]) if sd[i] and sd[j] else 0.0

ev = jacobi(C)
meff = sum(1 + (l - math.floor(l)) if l >= 1 else (l - math.floor(l)) for l in ev)
offd = [abs(C[i][j]) for i in range(m) for j in range(i + 1, m)]
print(f"family size m            = {m}")
print(f"mean |correlation|       = {sum(offd)/len(offd):.3f}   max = {max(offd):.3f}")
print(f"top eigenvalues          = {[round(v,2) for v in ev[:6]]}")
print(f"Li-Ji effective tests    = {meff:.1f}")
print(f"Sidak alpha for m_eff    = {1-(1-0.05)**(1/meff):.4f}")
print(f"Bonferroni alpha (m={m})  = {0.05/m:.4f}")
