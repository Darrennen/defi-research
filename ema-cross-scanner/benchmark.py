#!/usr/bin/env python3
"""Which EMA crosses are signal, and which are noise?

Every cross is scored against gates computable AT the cross bar (no look-ahead),
then forward returns of gated vs ungated crosses are compared to the unconditional
base rate over the same bars.

Guard against overfitting: history is split in half by time. A gate only counts if
it holds in BOTH halves. A gate that only works in-sample is reported as such.
"""

import json
import statistics
import sys
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from audit import deep_history
from scanner import PRESETS, TIMEFRAMES, ema, hl_klines, hl_universe, universe

N_COINS = 100
VENUE = (sys.argv[1] if len(sys.argv) > 1 else "binance")
DEEP_HL = Path(__file__).parent / "data" / "deep-hl"


def deep_hl(sym, tf):
    """All real HL candles for a market (synthetic pre-listing bars already trimmed)."""
    DEEP_HL.mkdir(parents=True, exist_ok=True)
    f = DEEP_HL / f"{sym}-{tf}.json"
    if f.exists():
        return json.loads(f.read_text())
    kl, _ = hl_klines(sym, tf, 5000)
    f.write_text(json.dumps(kl, separators=(",", ":")))
    return kl
HORIZONS = [10, 20, 50]
HTF = {"1h": "4h", "4h": "1d", "12h": "1d", "1d": "1w", "1w": None}


def series(kl):
    return {
        "t":  [int(k[0]) for k in kl],
        "ct": [int(k[6]) for k in kl],
        "c":  [float(k[4]) for k in kl],
        "h":  [float(k[2]) for k in kl],
        "l":  [float(k[3]) for k in kl],
        "qv": [float(k[7]) for k in kl],
    }


def state_timeline(kl, fp, sp):
    """[(bar_close_time, is_bull)] for a timeframe, for higher-timeframe lookups."""
    c = [float(k[4]) for k in kl]
    if len(c) < sp + 2:
        return [], []
    f, s = ema(c, fp), ema(c, sp)
    ts, st = [], []
    for i in range(sp - 1, len(c)):
        ts.append(int(kl[i][6]))
        st.append(f[i] > s[i])
    return ts, st


def htf_bull_at(ts, st, when):
    """Higher-timeframe regime as of the last HTF bar CLOSED at/before `when`."""
    if not ts:
        return None
    j = bisect_right(ts, when) - 1
    return st[j] if j >= 0 else None


def crosses(d, fp, sp, htf):
    """Every cross with its features and forward returns."""
    c, h, l, qv, ct = d["c"], d["h"], d["l"], d["qv"], d["ct"]
    n = len(c)
    if n < sp + max(HORIZONS) + 40:
        return [], []
    f, s = ema(c, fp), ema(c, sp)

    # ATR14 as a % of price, and rolling mean quote volume.
    tr = [0.0] * n
    for i in range(1, n):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i-1]), abs(l[i] - c[i-1]))

    warm = sp - 1 + int(1.25 * sp)   # same warmup skip the scanner uses
    out, base = [], []

    for i in range(sp - 1, n):
        for hz in HORIZONS:
            if i + hz < n:
                base.append((ct[i], hz, c[i + hz] / c[i] - 1))

    for i in range(max(warm, 40), n):
        prev, cur = f[i-1] - s[i-1], f[i] - s[i]
        if (cur > 0) == (prev > 0):
            continue
        golden = cur > 0
        w = 20
        slow_slope = (s[i] - s[i-w]) / s[i-w] * 100
        fast_slope = (f[i] - f[i-w]) / f[i-w] * 100
        ext = (c[i] - s[i]) / s[i] * 100
        vol_avg = statistics.mean(qv[i-w:i]) or 1
        atr = statistics.mean(tr[i-13:i+1]) / c[i] * 100
        # chop detector: how many crosses already happened in the prior 100 bars
        chop = 0
        for j in range(max(warm, i - 100) + 1, i):
            if (f[j] - s[j] > 0) != (f[j-1] - s[j-1] > 0):
                chop += 1

        fwd = {hz: (c[i + hz] / c[i] - 1) for hz in HORIZONS if i + hz < n}
        if not fwd:
            continue
        out.append({
            "t": ct[i], "golden": golden,
            "slow_slope": slow_slope, "fast_slope": fast_slope, "ext": ext,
            "vol_ratio": qv[i] / vol_avg, "vol_avg": vol_avg,
            "atr": atr, "chop": chop,
            "htf_bull": htf_bull_at(htf[0], htf[1], ct[i]),
            "fwd": fwd,
        })
    return out, base


# ---- gates: each takes a cross dict, returns True if it passes ----
def g_trend(x):     return x["slow_slope"] > 0 if x["golden"] else x["slow_slope"] < 0
def g_nochop(x):    return x["chop"] == 0
def g_htf(x):       return x["htf_bull"] is True if x["golden"] else x["htf_bull"] is False
def g_volexp(x):    return x["vol_ratio"] >= 1.2
def g_notext(x):    return abs(x["ext"]) <= 2.0 * x["atr"]
def g_momo(x):      return x["fast_slope"] > 0 if x["golden"] else x["fast_slope"] < 0

GATES = {
    "trend (slow EMA agrees)": g_trend,
    "no-chop (0 prior crosses/100b)": g_nochop,
    "HTF aligned": g_htf,
    "volume expansion >=1.2x": g_volexp,
    "not extended (<=2 ATR)": g_notext,
    "momentum (fast EMA agrees)": g_momo,
}


# The four classic gates, fixed in advance rather than picked after seeing results.
SCORE_GATES = ["trend (slow EMA agrees)", "no-chop (0 prior crosses/100b)",
               "volume expansion >=1.2x", "momentum (fast EMA agrees)"]


def score(x):
    return sum(1 for n in SCORE_GATES if GATES[n](x))


def edge(sample, base_by_h, hz):
    """Median forward return minus the base-rate median over the same horizon."""
    r = [x["fwd"][hz] for x in sample if hz in x["fwd"]]
    if len(r) < 25:
        return None
    b = base_by_h[hz]
    med = statistics.median(r)
    win = sum(1 for v in r if v > 0) / len(r) * 100
    return {"n": len(r), "med": med, "mean": statistics.mean(r), "win": win,
            "edge": (med - statistics.median(b)) * 100,
            "win_edge": win - (sum(1 for v in b if v > 0) / len(b) * 100)}


def fmt(e):
    return "  n/a" if not e else \
        f"{e['n']:>5} {e['win']:>5.1f}% {e['med']*100:>+7.2f}% {e['mean']*100:>+8.2f}% {e['edge']:>+7.2f}pp {e['win_edge']:>+6.1f}pp"


def main():
    if VENUE == "hyperliquid":
        coins = hl_universe(200_000, N_COINS)
        fetch, workers = deep_hl, 4
    else:
        coins = universe(1_000_000, N_COINS)
        fetch, workers = deep_history, 6
    syms = [c["symbol"] for c in coins]
    tasks = [(s, tf) for s in syms for tf in TIMEFRAMES]
    print(f"VENUE={VENUE}  deep history: {len(tasks)} series / {len(syms)} markets",
          file=sys.stderr)

    raw = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(fetch, s, tf): (s, tf) for s, tf in tasks}
        for n, (fut, key) in enumerate(futs.items(), 1):
            try:
                kl = fut.result()
                if len(kl) > 260:
                    raw[key] = kl
            except Exception as e:
                print(f"  skip {key}: {e}", file=sys.stderr)
            if n % 100 == 0:
                print(f"  {n}/{len(tasks)}", file=sys.stderr)
    print(f"usable series: {len(raw)}\n")

    preset = "50/200"
    fp, sp = PRESETS[preset]

    for tf in ["4h", "12h", "1d"]:
        htf_tf = HTF[tf]
        allx, base = [], []
        for s in syms:
            kl = raw.get((s, tf))
            if not kl:
                continue
            hkl = raw.get((s, htf_tf)) if htf_tf else None
            htf = state_timeline(hkl, fp, sp) if hkl else ([], [])
            xs, bs = crosses(series(kl), fp, sp, htf)
            allx += xs
            base += bs
        if not allx:
            continue

        # time split for out-of-sample validation
        times = sorted(x["t"] for x in allx)
        mid = times[len(times) // 2]
        base_by_h = {hz: [v for (_, h2, v) in base if h2 == hz] for hz in HORIZONS}
        base_tr = {hz: [v for (t, h2, v) in base if h2 == hz and t <= mid] for hz in HORIZONS}
        base_te = {hz: [v for (t, h2, v) in base if h2 == hz and t > mid] for hz in HORIZONS}

        for side, want in (("GOLDEN", True), ("DEATH", False)):
            pool_ = [x for x in allx if x["golden"] == want]
            if len(pool_) < 60:
                continue
            print("=" * 108)
            print(f"{tf}  EMA{preset}  {side}   crosses={len(pool_)}   "
                  f"HTF={htf_tf}   split at {mid}")
            print("=" * 108)
            print(f"  {'gate':34} {'h':>3} {'n':>5} {'win%':>6} {'median':>8} "
                  f"{'mean':>8} {'EDGE':>9} {'winEdge':>7}   {'OOS edge (early|late)':>22}")

            for hz in (20, 50):
                e = edge(pool_, base_by_h, hz)
                print(f"  {'ALL CROSSES (no gate)':34} {hz:>3} {fmt(e)}")
            print()

            for name, gate in GATES.items():
                sub = [x for x in pool_ if gate(x)]
                if len(sub) < 25:
                    print(f"  {name:34} {'--':>3} too few passing ({len(sub)})")
                    continue
                for hz in (20,):
                    e = edge(sub, base_by_h, hz)
                    tr = edge([x for x in sub if x["t"] <= mid], base_tr, hz)
                    te = edge([x for x in sub if x["t"] > mid], base_te, hz)
                    oos = (f"{tr['edge']:>+8.2f} | {te['edge']:>+8.2f}"
                           if tr and te else "        insufficient")
                    keep = "  OK" if (tr and te and tr["edge"] > 0 and te["edge"] > 0) else ""
                    print(f"  {name:34} {hz:>3} {fmt(e)}   {oos}{keep}")
            print()

            # AND-stacking every gate collapses the sample, so grade by HOW MANY of a
            # fixed 4-gate set pass. A real filter should show edge rising with score;
            # a fitted one won't be monotone.
            print(f"  SCORE BUCKETS over {len(SCORE_GATES)} gates "
                  f"{'(edge should rise with score for golden, fall for death)'}")
            for lo, hi in ((0, 1), (2, 2), (3, 3), (4, 4)):
                sub = [x for x in pool_ if lo <= score(x) <= hi]
                e = edge(sub, base_by_h, 20)
                tr = edge([x for x in sub if x["t"] <= mid], base_tr, 20)
                te = edge([x for x in sub if x["t"] > mid], base_te, 20)
                label = f"  score {lo}" + ("" if lo == hi else f"-{hi}")
                oos = (f"{tr['edge']:>+8.2f} | {te['edge']:>+8.2f}" if tr and te
                       else f"   n={len(sub)} too few")
                print(f"  {label:34} {20:>3} {fmt(e)}   {oos}")
            print()


if __name__ == "__main__":
    main()
