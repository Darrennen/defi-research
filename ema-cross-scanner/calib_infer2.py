#!/usr/bin/env python3
"""Inference respecting the dependence structure (fast rewrite of calib_infer).

  COIN-SWAP  null: keep the date, swap in a random other coin trading that bar.
                   Preserves date clustering + the full cross-sectional
                   correlation. Tests COIN-SELECTION skill (relative statistic).
  DATE-SHIFT null: keep the coin, shift EVERY cross by one common bar offset.
                   Preserves the joint clustering of crosses. Tests MARKET
                   TIMING (this is the null for benchmark.py's pooled edge).
  BLOCK BOOT     : resample non-overlapping HZ-bar calendar blocks -> CI that
                   accounts for overlapping forward windows.

Multiplicity: Westfall-Young. Each permutation draw scores the WHOLE family;
the FWER p-value is the share of draws whose max |stat| beats the observed one.
"""
import json
import random
import statistics
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ, MIN_XS = 20, 20
B, BOOT = 4000, 2000
random.seed(20260811)
BUCKETS = [("0-1", 0, 1), ("2", 2, 2), ("3", 3, 3), ("4", 4, 4), (">=3", 3, 4),
           ("ALL", 0, 4)]


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
        if r is None:
            continue
        day = panel.get(x["t"])
        if not day or len(day) < MIN_XS + 1:
            continue
        peers = [v for s, v in day.items() if s != x["sym"]]
        rows.append({"sym": x["sym"], "t": x["t"], "golden": x["golden"],
                     "score": score(x), "r": r, "mkt": fmed(peers),
                     "peers": peers, "blk": didx[x["t"]] // HZ,
                     "ci": cpos[x["sym"]][x["t"]]})
    return rows, base_med, coin_r


def main():
    fam = []
    ctx = {}
    for tf in ["4h", "12h", "1d"]:
        rows, base_med, coin_r = load(tf)
        ctx[tf] = (base_med, coin_r)
        for side, want in (("golden", True), ("death", False)):
            pool = [x for x in rows if x["golden"] == want]
            for lbl, lo, hi in BUCKETS:
                sub = [x for x in pool if lo <= x["score"] <= hi]
                if len(sub) >= 25:
                    fam.append((f"{tf} {side} s{lbl}", tf, sub))

    obs = {}
    for lbl, tf, sub in fam:
        bm = ctx[tf][0]
        obs[lbl] = (fmed([x["r"] for x in sub]) - bm) * 100, \
                   fmed([x["r"] - x["mkt"] for x in sub]) * 100

    # ---- NULL 1: coin swap ----
    nrel = {l: [] for l, _, _ in fam}
    mrel = []
    rr = random.random
    for _ in range(B):
        m = 0.0
        for lbl, tf, sub in fam:
            v = [x["peers"][int(rr() * len(x["peers"]))] - x["mkt"] for x in sub]
            z = fmed(v) * 100
            nrel[lbl].append(z)
            m = max(m, abs(z))
        mrel.append(m)

    # ---- NULL 2: common date shift ----
    npool = {l: [] for l, _, _ in fam}
    mpool = []
    shifts = [k for k in range(-800, 801) if abs(k) >= 30]
    for _ in range(B):
        k = shifts[int(rr() * len(shifts))]
        m = 0.0
        for lbl, tf, sub in fam:
            bm, coin_r = ctx[tf]
            v = []
            for x in sub:
                cr = coin_r[x["sym"]]
                j = x["ci"] + k
                if 0 <= j < len(cr):
                    v.append(cr[j])
            z = (fmed(v) - bm) * 100 if len(v) >= 25 else 0.0
            npool[lbl].append(z)
            m = max(m, abs(z))
        mpool.append(m)

    # ---- NULL 3: block bootstrap ----
    def ci(sub, tf, kind):
        bm = ctx[tf][0]
        blocks = {}
        for x in sub:
            blocks.setdefault(x["blk"], []).append(
                x["r"] if kind == "pool" else x["r"] - x["mkt"])
        keys = list(blocks.values())
        nk = len(keys)
        out = []
        for _ in range(BOOT):
            draw = []
            for _ in range(nk):
                draw += keys[int(rr() * nk)]
            z = fmed(draw)
            out.append((z - bm) * 100 if kind == "pool" else z * 100)
        out.sort()
        return out[int(.025 * BOOT)], out[int(.975 * BOOT)], nk

    def pv(nulls, o):
        return (1 + sum(1 for z in nulls if abs(z) >= abs(o))) / (len(nulls) + 1)

    def fw(mx, o):
        return (1 + sum(1 for z in mx if z >= abs(o))) / (len(mx) + 1)

    print(f"family = {len(fam)} tests, B={B} permutations, two-sided "
          f"(both signs were treated as discoveries, so two-sided is required)\n")
    h = (f"{'test':18} {'n':>4} {'blk':>4} | {'POOLED':>7} {'p':>6} {'pFWER':>6} "
         f"{'95% block CI':>17} | {'RELATIVE':>8} {'p':>6} {'pFWER':>6} "
         f"{'95% block CI':>17}")
    print(h)
    print("-" * len(h))
    rec = []
    for lbl, tf, sub in fam:
        op, orl = obs[lbl]
        p1, p2 = pv(npool[lbl], op), pv(nrel[lbl], orl)
        f1, f2 = fw(mpool, op), fw(mrel, orl)
        c1 = ci(sub, tf, "pool")
        c2 = ci(sub, tf, "rel")
        rec.append((lbl, p1, p2))
        print(f"{lbl:18} {len(sub):>4} {c1[2]:>4} | {op:>+7.2f} {p1:>6.4f} "
              f"{f1:>6.4f} [{c1[0]:>+6.2f},{c1[1]:>+6.2f}] | {orl:>+8.2f} "
              f"{p2:>6.4f} {f2:>6.4f} [{c2[0]:>+6.2f},{c2[1]:>+6.2f}]")

    for nm, i in (("POOLED (timing null)", 1), ("RELATIVE (selection null)", 2)):
        ps = sorted((r[i], r[0]) for r in rec)
        m = len(ps)
        k = 0
        for rank, (p, _) in enumerate(ps, 1):
            if p <= 0.05 * rank / m:
                k = rank
        print(f"\nBenjamini-Hochberg FDR 5%, {nm} (m={m}): {k} discoveries")
        for rank, (p, lbl) in enumerate(ps[:5], 1):
            print(f"   {rank}. {lbl:18} p={p:.4f}  thr={0.05*rank/m:.4f}  "
                  f"{'PASS' if rank <= k else 'fail'}")


if __name__ == "__main__":
    main()
