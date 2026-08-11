#!/usr/bin/env python3
"""Robustness of the 1d-golden relative edge: survivorship cohort, does the
score gate add anything, and does it replicate on Hyperliquid."""
import json
import os
import random
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import crosses, series, state_timeline, score, HTF     # noqa: E402
from scanner import PRESETS                                           # noqa: E402

D = Path(__file__).parent / "data"
HZ, FP, SP = 20, *PRESETS["50/200"]
random.seed(7)


def med(v):
    return statistics.median(v) if v else float("nan")


def boot_diff(a, b, n=20000):
    """P(median(a) - median(b) <= 0) by resampling both groups."""
    cnt = 0
    for _ in range(n):
        ra = [a[random.randrange(len(a))] for _ in range(len(a))]
        rb = [b[random.randrange(len(b))] for _ in range(len(b))]
        if statistics.median(ra) - statistics.median(rb) <= 0:
            cnt += 1
    return cnt / n


def rows_for(tf, venue="binance"):
    d = json.loads((D / f"calib_{tf}.json").read_text())
    panel = {int(k): v for k, v in d["panel"].items()}
    out = []
    for x in d["crosses"]:
        r = x["fwd"].get(str(HZ))
        if r is None:
            continue
        day = panel.get(x["t"], {})
        others = [v for s, v in day.items() if s != x["sym"]]
        if len(others) < 20:
            continue
        out.append({**x, "r": r, "rel": r - statistics.median(others),
                    "score": score(x)})
    return out


# ---------- 1. survivorship cohort ----------
print("=" * 80)
print("1d GOLDEN - survivorship: the universe is TODAY's top-100 by volume.")
print("Restrict to coins whose 1d history starts before the cutoff (long-listed).")
print("=" * 80)
start = {}
for f in os.listdir(D / "deep"):
    if f.endswith("-1d.json"):
        kl = json.loads((D / "deep" / f).read_text())
        if kl:
            start[f[:-8]] = int(kl[0][0])
rows = rows_for("1d")
gold = [x for x in rows if x["golden"]]
for cut, lbl in ((datetime(2020, 1, 1, tzinfo=timezone.utc), "listed pre-2020"),
                 (datetime(2022, 1, 1, tzinfo=timezone.utc), "listed pre-2022"),
                 (datetime(2024, 1, 1, tzinfo=timezone.utc), "listed pre-2024"),
                 (datetime(2030, 1, 1, tzinfo=timezone.utc), "all")):
    ms = cut.timestamp() * 1000
    cohort = {s for s, t in start.items() if t < ms}
    for tag, sub in (("ALL crosses", [x for x in gold if x["sym"] in cohort]),
                     ("score>=3", [x for x in gold if x["sym"] in cohort
                                   and x["score"] >= 3])):
        if len(sub) < 25:
            print(f"  {lbl:16} {tag:12} n={len(sub)} too few")
            continue
        print(f"  {lbl:16} {tag:12} coins={len({x['sym'] for x in sub}):>3} "
              f"n={len(sub):>4}  raw med {med([x['r'] for x in sub])*100:>+7.2f}%"
              f"  RELATIVE {med([x['rel'] for x in sub])*100:>+6.2f}pp")

# ---------- 2. does the score gate add anything? ----------
print("\n" + "=" * 80)
print("Does the 4-gate score ADD information? (gated vs rejected, same population)")
print("=" * 80)
for tf, want, lbl in (("1d", True, "1d golden"), ("4h", False, "4h death")):
    rr = [x for x in rows_for(tf) if x["golden"] == want]
    hi = [x["rel"] for x in rr if x["score"] >= 3]
    lo = [x["rel"] for x in rr if x["score"] < 3]
    hr = [x["r"] for x in rr if x["score"] >= 3]
    lr = [x["r"] for x in rr if x["score"] < 3]
    print(f"  {lbl}: score>=3 n={len(hi)} rel {med(hi)*100:+.2f}pp | "
          f"score<3 n={len(lo)} rel {med(lo)*100:+.2f}pp | "
          f"gap {(med(hi)-med(lo))*100:+.2f}pp  P(gap<=0)={boot_diff(hi, lo):.3f}")
    print(f"       raw: score>=3 {med(hr)*100:+.2f}% | score<3 {med(lr)*100:+.2f}% | "
          f"gap {(med(hr)-med(lr))*100:+.2f}%  P(gap<=0)={boot_diff(hr, lr):.3f}")

# ---------- 3. Hyperliquid replication of the RELATIVE statistic ----------
print("\n" + "=" * 80)
print("Hyperliquid (independent venue) - same relative statistic")
print("=" * 80)
DHL = D / "deep-hl"
syms = sorted({os.path.splitext(f)[0].rsplit("-", 1)[0] for f in os.listdir(DHL)})
for tf in ("4h", "1d"):
    allx, panel = [], {}
    for s in syms:
        p = DHL / f"{s}-{tf}.json"
        if not p.exists():
            continue
        kl = json.loads(p.read_text())
        if len(kl) <= 260:
            continue
        h = HTF[tf]
        hp = DHL / f"{s}-{h}.json" if h else None
        hkl = json.loads(hp.read_text()) if hp and hp.exists() else None
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
        for tag, lo in (("ALL", 0), ("score>=3", 3)):
            sub = []
            for x in allx:
                if x["golden"] != want or score(x) < lo:
                    continue
                r = x["fwd"].get(HZ, x["fwd"].get(str(HZ)))
                day = panel.get(x["t"], {})
                others = [v for s2, v in day.items() if s2 != x["sym"]]
                if r is None or len(others) < 20:
                    continue
                sub.append(r - statistics.median(others))
            if len(sub) < 25:
                print(f"  HL {tf} {side:7} {tag:9} n={len(sub)} too few")
                continue
            print(f"  HL {tf} {side:7} {tag:9} n={len(sub):>4} "
                  f"RELATIVE {med(sub)*100:>+6.2f}pp  "
                  f"relwin {sum(1 for v in sub if v>0)/len(sub)*100:.1f}%")
