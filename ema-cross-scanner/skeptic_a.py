#!/usr/bin/env python3
"""ATTACK A: is the pooled -> relative collapse caused by the BASE RATE being
wrong (market-timing bias), or by silently swapping the ESTIMATOR from
difference-of-medians to median-of-paired-differences?

Those are different claims. Decompose them.
"""
import json
import statistics as st
import sys
from pathlib import Path

sys.argv = [sys.argv[0]]
from benchmark import score                                          # noqa: E402

D = Path(__file__).parent / "data"
HZ, MIN_XS = 20, 20


def fmed(v):
    return st.median(v)


def load(tf):
    d = json.loads((D / f"calib_{tf}.json").read_text())
    panel = {int(k): v for k, v in d["panel"].items()}
    base = [v for (_, h, v) in d["base"] if h == HZ]
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
                     "score": score(x), "r": r, "mkt": fmed(peers)})
    return rows, base, panel


def btc_fwd(tf):
    """BTC's own 20-bar forward return, keyed by bar close time."""
    kl = json.loads((D / "deep" / f"BTCUSDT-{tf}.json").read_text())
    ct = [int(k[6]) for k in kl]
    c = [float(k[4]) for k in kl]
    return {ct[i]: c[i + HZ] / c[i] - 1 for i in range(len(c) - HZ)}


def block(name, sub, base, btc):
    r = [x["r"] for x in sub]
    m = [x["mkt"] for x in sub]
    rel = [x["r"] - x["mkt"] for x in sub]
    bm = fmed(base)
    print(f"\n### {name}   n={len(sub)}")
    print(f"  median own return          {fmed(r)*100:+7.2f}%")
    print(f"  POOLED all-time base med   {bm*100:+7.2f}%   -> pooled edge "
          f"{(fmed(r)-bm)*100:+6.2f}pp")
    print(f"  median of same-day mkt med {fmed(m)*100:+7.2f}%   -> "
          f"difference-of-medians vs contemporaneous "
          f"{(fmed(r)-fmed(m))*100:+6.2f}pp")
    print(f"  median of PAIRED (r - mkt)                    -> reviewer's "
          f"RELATIVE           {fmed(rel)*100:+6.2f}pp")
    print(f"    decomposition: base-rate reframing moves it "
          f"{((fmed(r)-fmed(m))-(fmed(r)-bm))*100:+.2f}pp; "
          f"estimator swap (diff-of-med -> med-of-diff) moves it "
          f"{(fmed(rel)-(fmed(r)-fmed(m)))*100:+.2f}pp")
    mr, mm = st.mean(r), st.mean(m)
    print(f"  MEANS (exactly additive): own {mr*100:+7.2f}%  mkt {mm*100:+7.2f}%"
          f"  alpha-over-mkt {(mr-mm)*100:+6.2f}pp   pooled-base mean "
          f"{st.mean(base)*100:+.2f}% -> {(mr-st.mean(base))*100:+.2f}pp")
    # OLS r ~ a + b*mkt
    vb = sum((v - mm) ** 2 for v in m)
    b = sum((x["r"] - mr) * (x["mkt"] - mm) for x in sub) / vb if vb else 0
    a = mr - b * mm
    print(f"  OLS r = a + b*mkt :  beta {b:5.2f}   alpha {a*100:+6.2f}%  "
          f"(beta-adjusted edge vs pooled base: {(a + b*st.mean(base) - st.mean(base))*100:+.2f}pp"
          f" of the {(mr-st.mean(base))*100:+.2f}pp is beta)")
    if btc:
        bp = [(x["r"] - btc[x["t"]]) for x in sub if x["t"] in btc]
        if bp:
            print(f"  BTC-relative (r - BTC fwd20), n={len(bp)}: "
                  f"median {fmed(bp)*100:+6.2f}pp  mean {st.mean(bp)*100:+6.2f}pp"
                  f"  win {sum(1 for v in bp if v>0)/len(bp)*100:.1f}%")


def timing_check(rows, panel, sub, label):
    """Are the dates the rule fires on unusually GOOD dates?"""
    mt = {t: fmed(list(v.values())) for t, v in panel.items()
          if len(v) >= MIN_XS + 1}
    allm = sorted(mt.values())
    at = sorted(x["mkt"] for x in sub)
    # percentile of the cross-date market median within all dates
    import bisect
    pct = [bisect.bisect_left(allm, v) / len(allm) * 100 for v in at]
    print(f"\n  TIMING check [{label}]: cross-sectional median forward return")
    print(f"    over ALL {len(allm)} panel dates : median {fmed(allm)*100:+.2f}%"
          f"  mean {st.mean(allm)*100:+.2f}%")
    print(f"    on the {len(sub)} cross dates    : median {fmed(at)*100:+.2f}%"
          f"  mean {st.mean(at)*100:+.2f}%")
    print(f"    mean percentile of a cross date among all dates: "
          f"{st.mean(pct):.1f} (50 = no timing edge)")


def main():
    for tf, side, want in (("1d", "golden", True), ("4h", "death", False)):
        rows, base, panel = load(tf)
        btc = btc_fwd(tf)
        pool = [x for x in rows if x["golden"] == want]
        print("=" * 92)
        print(f"{tf} {side.upper()}")
        print("=" * 92)
        for lbl, sel in (("score>=3", lambda x: x["score"] >= 3),
                         ("ungated", lambda x: True)):
            sub = [x for x in pool if sel(x)]
            block(lbl, sub, base, btc)
        timing_check(rows, panel, [x for x in pool if x["score"] >= 3],
                     f"{tf} {side} score>=3")


main()
