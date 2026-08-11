#!/usr/bin/env python3
"""Emit a weekly EMA-cross watchlist from data/scan.json.

Scope is deliberately narrow. Two independent calibration passes (calib_*.py,
skeptic_*.py, 2026-08-11) agreed that only ONE rule has any measurable edge and
that even it is unconfirmed:

  1d golden, 50/200, score>=3  -- peer-relative +2.16pp median / +7.5pp
  winsorised mean over 20 bars (n=144), coin-swap p=0.008, block-bootstrap CI
  [+3.5, +12.2], not explained by 12-week momentum. FWER ~0.10 on a 24-rule
  family, and BH discovery is estimator-dependent. Hence "weak edge,
  unconfirmed", never "signal".

Everything else is suppressed: 4h death (killed on both venues under every
statistic), all death crosses, 1h/1w (never benchmarked), Hyperliquid and the
HIP-3 builder dexs, non-crypto asset classes, and the 21/55 preset.

score>=3 is kept only as an alert-volume throttle (-23% alerts). The test that
claimed the gate adds edge had 8% power; the test that claimed it adds none was
equally underpowered. No edge claim is made for it either way.

Reads  : data/scan.json  (written by scanner.py)
State  : .alert_state.json  (gitignored) -- dedupes by cross_time so one cross
         is reported once, not on every run for the 20 days its grade lives.
Output : Slack mrkdwn on stdout. Prints NOTHING and exits 0 when there is
         nothing new, so the caller can skip delivery.
"""

import argparse
import json
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

MIN_VOL = 10_000_000      # measured population median was $36.5M/day, p25 $10.6M
MIN_BARS = 700            # 3.5x slow period; at 1.5x the cross lands on the
                          # wrong bar 62% of the time (README)
MIN_SCORE = 3
FRESH_BARS = 20           # grade lifetime; also the horizon the edge was measured over
TOP_N = 5

DISCLAIMER = (
    "_Watchlist, not a signal._ 1d golden crosses in this population ran "
    "*+2.2pp median / +7.5pp winsorised mean* over the next 20 bars vs same-day "
    "peers (n=144). Real but unconfirmed: FWER ~0.10, and the edge is tail-driven "
    "— it needs breadth, so cherry-picking a few of these captures none of it. "
    "No direction is claimed."
)


def load(path):
    with open(path) as fh:
        return json.load(fh)


def daily(coin):
    return (coin.get("tf") or {}).get("1d", {}).get("50/200")


def qualifies(coin, pane, max_bars_since):
    if coin.get("venue") != "binance" or coin.get("quote_label") != "USDT":
        return False
    if coin.get("asset_class") != "crypto":
        return False
    if not pane or pane.get("cross") != "golden":
        return False
    bars_since = pane.get("bars_since")
    if bars_since is None or bars_since > max_bars_since:
        return False
    if coin.get("quote_vol_24h", 0) < MIN_VOL:
        return False
    if pane.get("bars_available", 0) < MIN_BARS:
        return False
    if (pane.get("score") or 0) < MIN_SCORE:
        return False
    return True


def btc_regime(coins):
    """BTC 1d close vs its own EMA200. The measured rule fired with BTC above
    its 1d EMA200 in 130 of 144 cases, so the bear case is effectively untested."""
    for c in coins:
        if c.get("symbol") == "BTCUSDT" and c.get("venue") == "binance":
            pane = daily(c)
            if pane and pane.get("close") and pane.get("slow"):
                close, ema200 = pane["close"], pane["slow"]
                side = "above" if close > ema200 else "BELOW"
                pct = (close / ema200 - 1) * 100
                note = "" if close > ema200 else "  ⚠️ rule never tested here"
                return f"BTC {side} 1d EMA200 ({pct:+.1f}%){note}"
    return "BTC regime unavailable"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", default=str(HERE / "data" / "scan.json"))
    ap.add_argument("--state", default=str(HERE / ".alert_state.json"))
    ap.add_argument("--max-age-bars", type=int, default=7,
                    help="report crosses this many bars old or fresher")
    ap.add_argument("--no-state", action="store_true",
                    help="ignore and do not write dedupe state (dry run)")
    args = ap.parse_args()

    scan = load(args.scan)
    coins = scan.get("coins", [])

    # scanner.py sets asset_class from sectors.classify(); if CoinGecko is
    # unreachable or rate-limited it logs "sector tags unavailable" and leaves
    # every Binance row untagged. The crypto-only filter would then match
    # nothing and this script would report "no crosses" indefinitely with no
    # error. Fail loudly instead -- silence must mean "no crosses", never
    # "the pipeline broke".
    binance = [c for c in coins if c.get("venue") == "binance"]
    if binance and not any(c.get("asset_class") for c in binance):
        raise SystemExit(
            "DATA ERROR: no asset_class on any Binance row -- sector tagging "
            "failed upstream (CoinGecko rate limit?). Refusing to report, "
            "because the crypto-only filter cannot be applied."
        )

    # scanner.py exits 0 even when most kline fetches failed -- it just writes a
    # sparse scan.json and prints the error count to stderr. A 2026-08-11 run lost
    # 2006 of 2130 series to a Binance IP rate-ban and left only 21 of 425 rows
    # with a usable 1d pane; this script happily reported "no new crosses". A
    # healthy scan sits near 83% coverage, so refuse below 40%.
    with_pane = sum(1 for c in binance if daily(c))
    coverage = with_pane / len(binance) if binance else 0
    if binance and coverage < 0.40:
        raise SystemExit(
            f"DATA ERROR: only {with_pane}/{len(binance)} Binance rows "
            f"({coverage:.0%}) have a usable 1d pane; a healthy scan is ~83%. "
            "The scan lost most of its price series (rate-ban?). Refusing to "
            "report, because 'no crosses' would be indistinguishable from "
            "'no data'."
        )

    state = {}
    state_path = Path(args.state)
    if not args.no_state and state_path.exists():
        state = json.loads(state_path.read_text())
    seen = set(state.get("seen", []))

    hits, crowding = [], 0
    for coin in coins:
        pane = daily(coin)
        if qualifies(coin, pane, FRESH_BARS):
            crowding += 1
        if not qualifies(coin, pane, args.max_age_bars):
            continue
        key = f"{coin['symbol']}|1d|{pane.get('cross_time')}"
        if key in seen:
            continue
        hits.append((key, coin, pane))

    if not hits:
        return  # silent: nothing new

    hits.sort(key=lambda h: h[1].get("quote_vol_24h", 0), reverse=True)
    shown = hits[:TOP_N]

    age_h = (time.time() * 1000 - scan.get("generated_at", 0)) / 3.6e6
    out = [f"*📈 EMA 1d golden — watchlist* ({len(hits)} new)"]
    out.append(f"{btc_regime(coins)}  ·  {crowding} qualifying in trailing 20d")
    if age_h > 36:
        out.append(f"⚠️ scan data is {age_h/24:.1f} days old")
    out.append("")

    for _, coin, pane in shown:
        vol = coin.get("quote_vol_24h", 0) / 1e6
        gates = pane.get("gates") or {}
        passed = ",".join(g for g, ok in gates.items() if ok) or "none"
        out.append(
            f"*{coin['base']}* — crossed {pane.get('bars_since')}d ago @ "
            f"{pane.get('cross_price')}  ·  now {coin.get('price')} "
            f"({pane.get('pct_since_cross', 0):+.1f}%)"
        )
        out.append(
            f"   ${vol:,.0f}M/24h · score {pane.get('score')}/4 ({passed}) · "
            f"{pane.get('bars_available')} bars"
        )

    if len(hits) > TOP_N:
        out.append(f"_+{len(hits) - TOP_N} more below the top {TOP_N} by volume_")
    out.append("")
    out.append(DISCLAIMER)
    print("\n".join(out))

    if not args.no_state:
        seen.update(k for k, _, _ in hits)
        # keep the file from growing without bound; keys are ordered by insertion
        trimmed = list(seen)[-2000:]
        state_path.write_text(json.dumps({"seen": trimmed}, indent=1))


if __name__ == "__main__":
    main()
