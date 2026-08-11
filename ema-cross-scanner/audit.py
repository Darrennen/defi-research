#!/usr/bin/env python3
"""Two independent accuracy audits of the scanner.

A) NUMERIC: does a 1000-bar window reproduce the EMA you'd get from a coin's full
   history, and does any error change the actual cross verdict?
B) SIGNAL: do EMA50/200 crosses predict forward returns better than the
   unconditional base rate over the same bars?

Deep history is cached to data/deep/ so the analysis can be re-run without refetching.
"""

import json
import statistics
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from scanner import BARS, PRESETS, TIMEFRAMES, analyse, ema, get, universe

DEEP = Path(__file__).parent / "data" / "deep"
HORIZONS = [10, 20, 50]
N_COINS = 40


def deep_history(sym, tf, pages=5):
    """All available klines, paged backwards. Cached on disk."""
    DEEP.mkdir(parents=True, exist_ok=True)
    f = DEEP / f"{sym}-{tf}.json"
    if f.exists():
        return json.loads(f.read_text())
    out = get("/api/v3/klines", {"symbol": sym, "interval": tf, "limit": 1000})[:-1]
    end = out[0][0] - 1 if out else None
    for _ in range(pages - 1):
        if end is None:
            break
        chunk = get("/api/v3/klines", {"symbol": sym, "interval": tf,
                                      "limit": 1000, "endTime": end})
        if not chunk:
            break
        out = chunk + out
        end = chunk[0][0] - 1
        if len(chunk) < 1000:
            break
    f.write_text(json.dumps(out, separators=(",", ":")))
    return out


def audit_numeric(data):
    """Compare the scanner's 1000-bar EMAs against full-history EMAs."""
    rows = []
    verdict_diffs = []
    for (sym, tf), kl in data.items():
        closes = [float(k[4]) for k in kl]
        highs = [float(k[2]) for k in kl]
        lows = [float(k[3]) for k in kl]
        times = [int(k[0]) for k in kl]
        if len(closes) <= BARS:
            continue  # no extra history to compare against
        for name, (fp, sp) in PRESETS.items():
            win = analyse(closes[-BARS + 1:], highs[-BARS + 1:], lows[-BARS + 1:],
                          times[-BARS + 1:], fp, sp)
            full = analyse(closes, highs, lows, times, fp, sp)
            if not win or not full:
                continue
            e_fast = abs(win["fast"] - full["fast"]) / full["fast"] * 100
            e_slow = abs(win["slow"] - full["slow"]) / full["slow"] * 100
            rows.append({"sym": sym, "tf": tf, "preset": name,
                         "e_fast": e_fast, "e_slow": e_slow,
                         "e_spread": abs(win["spread_pct"] - full["spread_pct"])})
            if win["state"] != full["state"] or win["bars_since"] != full["bars_since"]:
                wb, fb = win["bars_since"], full["bars_since"]
                # A window can only see back as far as its own search range. If full
                # history finds an older cross beyond that, it is a range limit, not
                # an error - so classify those separately from genuine disagreements.
                range_limited = (wb is None and fb is not None and fb > win["search_bars"]) \
                    or (wb is not None and fb is not None and wb > win["search_bars"] - 5)
                verdict_diffs.append({
                    "sym": sym, "tf": tf, "preset": name,
                    "win": (win["state"], wb), "full": (full["state"], fb),
                    "search": win["search_bars"],
                    "kind": "range-limit" if range_limited else "DISAGREEMENT",
                    "recent": (wb is not None and wb <= 100) or (fb is not None and fb <= 100),
                })
    return rows, verdict_diffs


def audit_signal(data):
    """Forward returns after every cross vs the unconditional base rate."""
    stats = {}
    for (sym, tf), kl in data.items():
        closes = [float(k[4]) for k in kl]
        for name, (fp, sp) in PRESETS.items():
            if len(closes) < sp + max(HORIZONS) + 5:
                continue
            f, s = ema(closes, fp), ema(closes, sp)
            key = (tf, name)
            st = stats.setdefault(key, {"golden": {h: [] for h in HORIZONS},
                                        "death": {h: [] for h in HORIZONS},
                                        "base": {h: [] for h in HORIZONS},
                                        "coins": set()})
            st["coins"].add(sym)

            start = sp - 1
            # Unconditional base rate over exactly the bars where a signal was possible.
            for i in range(start, len(closes)):
                for h in HORIZONS:
                    if i + h < len(closes):
                        st["base"][h].append(closes[i + h] / closes[i] - 1)

            for i in range(start + 1, len(closes)):
                prev, cur = f[i - 1] - s[i - 1], f[i] - s[i]
                if (cur > 0) == (prev > 0):
                    continue
                side = "golden" if cur > 0 else "death"
                for h in HORIZONS:
                    if i + h < len(closes):
                        st[side][h].append(closes[i + h] / closes[i] - 1)
    return stats


def pct(x):
    return f"{x * 100:+.2f}%"


def main():
    coins = universe(1_000_000, N_COINS)
    tasks = [(c["symbol"], tf) for c in coins for tf in TIMEFRAMES]
    print(f"fetching deep history: {len(tasks)} series over {len(coins)} coins",
          file=sys.stderr)

    data = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = {pool.submit(deep_history, s, tf): (s, tf) for s, tf in tasks}
        for n, (fut, key) in enumerate(futs.items(), 1):
            try:
                kl = fut.result()
                if len(kl) > 60:
                    data[key] = kl
            except Exception as e:
                print(f"  skip {key}: {e}", file=sys.stderr)
            if n % 50 == 0:
                print(f"  {n}/{len(tasks)}", file=sys.stderr)

    print(f"\nseries with usable history: {len(data)}")
    print(f"total bars: {sum(len(v) for v in data.values()):,}\n")

    # ---------- A ----------
    rows, diffs = audit_numeric(data)
    print("=" * 72)
    print("A) NUMERIC ACCURACY - 1000-bar window vs full history")
    print("=" * 72)
    for field, label in [("e_fast", "fast EMA"), ("e_slow", "slow EMA")]:
        v = sorted(r[field] for r in rows)
        print(f"  {label:9} error: median {statistics.median(v):.4f}%  "
              f"p95 {v[int(len(v) * .95)]:.4f}%  max {max(v):.4f}%")
    sv = sorted(r["e_spread"] for r in rows)
    print(f"  spread    error: median {statistics.median(sv):.4f}pp  max {max(sv):.4f}pp")
    real = [d for d in diffs if d["kind"] == "DISAGREEMENT"]
    limited = [d for d in diffs if d["kind"] == "range-limit"]
    recent = [d for d in real if d["recent"]]
    print(f"\n  comparisons: {len(rows)}")
    print(f"  genuine disagreements:            {len(real)} "
          f"({len(real) / max(len(rows), 1) * 100:.1f}%)")
    print(f"  of those, on a RECENT cross (<=100 bars): {len(recent)}   "
          f"<-- the actionable zone")
    print(f"  expected range limits (older cross outside window): {len(limited)}")
    for d in real[:12]:
        print(f"    {d['kind']:13} {d['sym']:12} {d['tf']:3} {d['preset']:7} "
              f"window={d['win']} full={d['full']} search={d['search']}")

    # ---------- B ----------
    print("\n" + "=" * 72)
    print("B) SIGNAL ACCURACY - forward return after cross vs base rate")
    print("=" * 72)
    st_all = audit_signal(data)
    for preset in PRESETS:
        print(f"\n  --- EMA {preset} ---")
        print(f"  {'tf':4} {'side':7} {'n':>5} {'h':>4} {'win%':>7} {'median':>9} "
              f"{'mean':>9} | {'base win%':>9} {'base med':>9} {'edge':>8}")
        for tf in TIMEFRAMES:
            st = st_all.get((tf, preset))
            if not st:
                continue
            for side in ("golden", "death"):
                for h in HORIZONS:
                    r = st[side][h]
                    b = st["base"][h]
                    if len(r) < 20:
                        continue
                    w = sum(1 for x in r if x > 0) / len(r) * 100
                    bw = sum(1 for x in b if x > 0) / len(b) * 100
                    med, bmed = statistics.median(r), statistics.median(b)
                    print(f"  {tf:4} {side:7} {len(r):>5} {h:>4} {w:>6.1f}% "
                          f"{pct(med):>9} {pct(statistics.mean(r)):>9} | "
                          f"{bw:>8.1f}% {pct(bmed):>9} {pct(med - bmed):>8}")
        print(f"  coins: {len(st_all[(TIMEFRAMES[0], preset)]['coins'])}")


if __name__ == "__main__":
    t0 = time.time()
    main()
    print(f"\ndone in {time.time() - t0:.0f}s", file=sys.stderr)
