#!/usr/bin/env python3
"""Self-skeptic pass on the ONE result that survived my attack: the winsorised /
log-mean peer-relative edge of 1d golden.

If it is real it must (a) not be one year, (b) not be one coin, (c) show up on
Hyperliquid, (d) survive costs. Anything that fails these is not a signal.
"""
import json
import math
import os
import random
import statistics as st
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import crosses, series, state_timeline, score, HTF     # noqa: E402
from scanner import PRESETS                                           # noqa: E402

D = Path(__file__).parent / "data"
HZ, MIN_XS, B = 20, 20, 4000
FP, SP = PRESETS["50/200"]
random.seed(4004)
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


def logm(pairs):
    return st.mean(math.log(1 + a) - math.log(1 + b) for a, b in pairs)


def rows_bin():
    d = json.loads((D / "calib_1d.json").read_text())
    panel = {int(k): v for k, v in d["panel"].items()}
    out = []
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ))
        day = panel.get(x["t"])
        if r is None or not day or len(day) < MIN_XS + 1:
            continue
        peers = [v for s, v in day.items() if s != x["sym"]]
        if len(peers) < MIN_XS:
            continue
        out.append({"sym": x["sym"], "t": x["t"], "golden": x["golden"],
                    "score": score(x), "r": r, "mkt": fmed(peers),
                    "peers": peers,
                    "yr": datetime.fromtimestamp(x["t"] / 1000,
                                                 timezone.utc).year})
    return out


def swap_p(sub, statname):
    """coin-swap p-value for a given statistic."""
    def s(pairs):
        if statname == "wins":
            return wins([a - b for a, b in pairs])
        return logm(pairs)
    o = s([(x["r"], x["mkt"]) for x in sub])
    nl = [s([(x["peers"][int(rr() * len(x["peers"]))], x["mkt"]) for x in sub])
          for _ in range(B)]
    return o, (1 + sum(1 for z in nl if abs(z) >= abs(o))) / (B + 1)


def main():
    rows = rows_bin()
    sub = [x for x in rows if x["golden"] and x["score"] >= 3]
    print("=" * 90)
    print(f"1d golden score>=3, Binance   n={len(sub)}")
    print("=" * 90)

    print("\n-- (a) by year --")
    print(f"  {'yr':6} {'n':>4} {'medrel':>8} {'winsrel':>9} {'logrel':>8}")
    for y in sorted({x["yr"] for x in sub}):
        s = [x for x in sub if x["yr"] == y]
        d = [x["r"] - x["mkt"] for x in s]
        print(f"  {y:6} {len(s):>4} {fmed(d)*100:>+8.2f} {wins(d)*100:>+9.2f} "
              f"{logm([(x['r'], x['mkt']) for x in s])*100:>+8.2f}"
              + ("   (thin)" if len(s) < 15 else ""))
    ys = sorted({x["yr"] for x in sub})
    pos = sum(1 for y in ys if wins([x["r"] - x["mkt"]
                                     for x in sub if x["yr"] == y]) > 0)
    print(f"  winsrel positive in {pos}/{len(ys)} years")

    print("\n-- (a2) split-half --")
    ts = sorted(x["t"] for x in sub)
    mid = ts[len(ts) // 2]
    for tag, s in (("early", [x for x in sub if x["t"] <= mid]),
                   ("late", [x for x in sub if x["t"] > mid])):
        d = [x["r"] - x["mkt"] for x in s]
        o, p = swap_p(s, "wins")
        print(f"  {tag:6} n={len(s):>4} medrel {fmed(d)*100:>+6.2f}  "
              f"winsrel {o*100:>+6.2f} (coin-swap p={p:.4f})")

    print("\n-- (b) leave-one-coin-out on the winsorised statistic --")
    full = wins([x["r"] - x["mkt"] for x in sub])
    lo = []
    for c in {x["sym"] for x in sub}:
        s = [x for x in sub if x["sym"] != c]
        lo.append((wins([x["r"] - x["mkt"] for x in s]) * 100, c,
                   sum(1 for x in sub if x["sym"] == c)))
    lo.sort()
    print(f"  full {full*100:+.2f}pp | worst-case drops: " +
          ", ".join(f"{c}(n={k}) -> {v:+.2f}" for v, c, k in lo[:4]))
    print(f"  min over all {len(lo)} leave-one-out fits: {lo[0][0]:+.2f}pp  "
          f"max: {lo[-1][0]:+.2f}pp")

    print("\n-- (d) round-trip cost applied to the coin's leg only --")
    for bp in (0, 20, 40, 60, 100):
        d = [(x["r"] - bp / 10000) - x["mkt"] for x in sub]
        print(f"  {bp:>4}bp  medrel {fmed(d)*100:>+6.2f}pp  "
              f"winsrel {wins(d)*100:>+6.2f}pp")

    # ---- (c) Hyperliquid ----
    print("\n-- (c) Hyperliquid, same statistics --")
    DHL = D / "deep-hl"
    syms = sorted({os.path.splitext(f)[0].rsplit("-", 1)[0]
                   for f in os.listdir(DHL)})
    allx, panel = [], {}
    for s in syms:
        p = DHL / f"{s}-1d.json"
        if not p.exists():
            continue
        kl = json.loads(p.read_text())
        if len(kl) <= 260:
            continue
        hp = DHL / f"{s}-{HTF['1d']}.json"
        hkl = json.loads(hp.read_text()) if hp.exists() else None
        if hkl and len(hkl) <= 260:
            hkl = None
        htf = state_timeline(hkl, FP, SP) if hkl else ([], [])
        d = series(kl)
        xs, _ = crosses(d, FP, SP, htf)
        for x in xs:
            x["sym"] = s
        allx += xs
        c, ct = d["c"], d["ct"]
        for i in range(len(c) - HZ):
            panel.setdefault(ct[i], {})[s] = c[i + HZ] / c[i] - 1
    for side, want in (("golden", True), ("death", False)):
        for tag, mn in (("ALL", 0), ("score>=3", 3)):
            hs = []
            for x in allx:
                if x["golden"] != want or score(x) < mn:
                    continue
                r = x["fwd"].get(HZ, x["fwd"].get(str(HZ)))
                day = panel.get(x["t"], {})
                peers = [v for s2, v in day.items() if s2 != x["sym"]]
                if r is None or len(peers) < MIN_XS:
                    continue
                hs.append({"r": r, "mkt": fmed(peers), "peers": peers})
            if len(hs) < 25:
                print(f"  HL 1d {side:7} {tag:9} n={len(hs)} too few")
                continue
            d = [x["r"] - x["mkt"] for x in hs]
            o, p = swap_p(hs, "wins")
            print(f"  HL 1d {side:7} {tag:9} n={len(hs):>4} "
                  f"medrel {fmed(d)*100:>+6.2f}pp  winsrel {o*100:>+6.2f}pp "
                  f"(coin-swap p={p:.4f})")


main()
