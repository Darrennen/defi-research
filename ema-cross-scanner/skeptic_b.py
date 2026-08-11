#!/usr/bin/env python3
"""ATTACK A2/B: the reviewer's RELATIVE statistic is a MEDIAN of paired
differences. The project's own README says the edge lives in the tail
("mean >> median everywhere"). A median-of-differences on a fat-tailed,
positively-skewed panel is close to a worst-case estimator for that effect.

Re-run the same peer-relative comparison under four statistics, each with the
SAME coin-swap null (keep the date + the peer set, swap in a random peer's
return) and the same 20-bar non-overlapping block bootstrap.

  medrel  = median(r - mkt)              <- the reviewer's choice
  meanrel = mean(r - mkt)                <- exactly additive, tail-sensitive
  winrel  = mean(r - mkt), 10% winsorised on each side
  logrel  = mean(log(1+r) - log(1+mkt))  <- compounding edge of a long-only book
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
HZ, MIN_XS = 20, 20
B, BOOT = 4000, 4000
random.seed(11082026)
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


STATS = {
    "medrel":  lambda pr: fmed(pr) * 100,
    "meanrel": lambda pr: st.mean(pr) * 100,
    "winrel":  lambda pr: wins(pr) * 100,
}


def load(tf):
    d = json.loads((D / f"calib_{tf}.json").read_text())
    panel = {int(k): v for k, v in d["panel"].items()}
    alld = sorted(panel)
    didx = {t: i for i, t in enumerate(alld)}
    rows = []
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ))
        if r is None:
            continue
        day = panel.get(x["t"])
        if not day or len(day) < MIN_XS + 1:
            continue
        peers = [v for s, v in day.items() if s != x["sym"]]
        if len(peers) < MIN_XS:
            continue
        rows.append({"sym": x["sym"], "t": x["t"], "golden": x["golden"],
                     "score": score(x), "r": r, "mkt": fmed(peers),
                     "peers": peers, "blk": didx[x["t"]] // HZ})
    return rows


def logrel(pairs):
    return st.mean(math.log(1 + a) - math.log(1 + b) for a, b in pairs) * 100


def run(name, sub):
    pr = [x["r"] - x["mkt"] for x in sub]
    pairs = [(x["r"], x["mkt"]) for x in sub]
    obs = {k: f(pr) for k, f in STATS.items()}
    obs["logrel"] = logrel(pairs)

    # ---- coin-swap null: same date, same peer median, random peer as "the pick"
    nulls = {k: [] for k in obs}
    for _ in range(B):
        draw = [(x["peers"][int(rr() * len(x["peers"]))], x["mkt"]) for x in sub]
        d = [a - b for a, b in draw]
        for k, f in STATS.items():
            nulls[k].append(f(d))
        nulls["logrel"].append(logrel(draw))

    # ---- block bootstrap over non-overlapping 20-bar calendar blocks
    blocks = {}
    for x in sub:
        blocks.setdefault(x["blk"], []).append((x["r"], x["mkt"]))
    keys = list(blocks.values())
    nk = len(keys)
    boots = {k: [] for k in obs}
    for _ in range(BOOT):
        dr = []
        for _ in range(nk):
            dr += keys[int(rr() * nk)]
        d = [a - b for a, b in dr]
        for k, f in STATS.items():
            boots[k].append(f(d))
        boots["logrel"].append(logrel(dr))

    print(f"\n### {name}   n={len(sub)}  blocks={nk}")
    print(f"  {'stat':8} {'observed':>9} {'null med':>9} {'null p95':>9} "
          f"{'p(2-sided)':>11} {'95% block CI':>18}")
    for k in ("medrel", "meanrel", "winrel", "logrel"):
        nl = sorted(nulls[k])
        o = obs[k]
        p = (1 + sum(1 for z in nl if abs(z) >= abs(o))) / (B + 1)
        bs = sorted(boots[k])
        print(f"  {k:8} {o:>+9.2f} {fmed(nl):>+9.2f} {nl[int(.95*B)]:>+9.2f} "
              f"{p:>11.4f}   [{bs[int(.025*BOOT)]:>+6.2f},{bs[int(.975*BOOT)]:>+6.2f}]")
    return obs, nulls


def main():
    fam = []
    for tf in ("4h", "12h", "1d"):
        rows = load(tf)
        for side, want in (("golden", True), ("death", False)):
            pool = [x for x in rows if x["golden"] == want]
            fam.append((f"{tf} {side} score>=3",
                        [x for x in pool if x["score"] >= 3]))
    keep = {"1d golden score>=3", "4h death score>=3"}
    res = {}
    for name, sub in fam:
        if len(sub) < 25:
            continue
        res[name] = run(name, sub)

    # Westfall-Young FWER over the 6-combo pre-registered family, meanrel
    print("\n--- Westfall-Young FWER over the 6 pre-registered combos ---")
    for k in ("medrel", "meanrel", "winrel", "logrel"):
        mx = [max(abs(res[n][1][k][i]) for n in res) for i in range(B)]
        for n in sorted(res):
            if n not in keep:
                continue
            o = res[n][0][k]
            f = (1 + sum(1 for z in mx if z >= abs(o))) / (B + 1)
            print(f"  {k:8} {n:22} obs {o:+7.2f}  pFWER(m=6) {f:.4f}")


main()
