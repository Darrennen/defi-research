#!/usr/bin/env python3
"""Scan Binance USDT spot pairs for EMA golden/death crosses across timeframes.

Data source: Binance public REST API (no key required).
Crosses are detected on CLOSED candles only - the in-progress bar is discarded
so a cross cannot flicker in and out intra-bar.
"""

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import sectors

BASE = "https://api.binance.com"
DATA = Path(__file__).parent / "data"

TIMEFRAMES = ["1h", "4h", "12h", "1d", "1w"]

# 1000 bars, not 500. An EMA200 seeded at bar 200 of a 500-bar window carries up
# to ~0.8% warmup error (measured on SOLUSDT 1d); at 1000 bars it is ~0.002%.
# That matters here because a cross IS the two EMAs meeting - sub-1% error on the
# slow EMA invents crosses that never happened. Costs kline weight 5 instead of 2.
BARS = 1000

# Binance allows 6000 request-weight per minute per IP. Back off before we hit it.
WEIGHT_CEILING = 4800
_throttle = threading.Lock()

# (fast, slow) EMA presets. "50/200" is the textbook golden/death cross.
PRESETS = {"50/200": (50, 200), "21/55": (21, 55)}

# Quote assets that are just stablecoin pairs, and leveraged-token suffixes.
STABLES = {
    "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "GBP", "TRY", "BRL",
    "AEUR", "USD1", "XUSD", "PYUSD", "EURI", "USDS", "RLUSD",
}
LEVERAGED = ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")


def get(path, params=None, retries=5):
    """GET with backoff on 429/418 (rate limit) and transient 5xx."""
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ema-scanner/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                used = int(r.headers.get("X-MBX-USED-WEIGHT-1M", 0))
                body = json.loads(r.read())
            if used > WEIGHT_CEILING:
                # Serialise every worker behind one sleep so the minute window resets.
                with _throttle:
                    print(f"  weight {used}/6000, pausing 12s", file=sys.stderr)
                    time.sleep(12)
            return body
        except urllib.error.HTTPError as e:
            if e.code in (429, 418):
                wait = int(e.headers.get("Retry-After", 2 ** attempt))
                print(f"  rate limited ({e.code}), sleeping {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            if 500 <= e.code < 600:
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed after {retries} tries: {url}")


HL_API = "https://api.hyperliquid.xyz/info"
HL_MS = {"1h": 3600000, "4h": 14400000, "12h": 43200000, "1d": 86400000, "1w": 604800000}


_hl_gate = threading.Lock()
_hl_last = [0.0]
HL_MIN_INTERVAL = 0.12   # ~8 req/s; bursts above this got rejected at 4 workers


def _hl_pace():
    """Space HL requests globally - concurrency alone caused ~4% transient failures."""
    with _hl_gate:
        wait = HL_MIN_INTERVAL - (time.time() - _hl_last[0])
        if wait > 0:
            time.sleep(wait)
        _hl_last[0] = time.time()


def hl_post(body, retries=7):
    data = json.dumps(body).encode()
    last = None
    for attempt in range(retries):
        _hl_pace()
        try:
            req = urllib.request.Request(
                HL_API, data=data,
                headers={"Content-Type": "application/json", "User-Agent": "ema-scanner/1.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 or 500 <= e.code < 600:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"HL HTTP {e.code} on {body.get('type')}") from e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"HL request failed after {retries} tries: "
                       f"{body.get('type')} ({type(last).__name__})")


# HIP-3 builder dexs list real-world markets HL's main perp dex does not carry -
# trade.xyz alone runs ~$2.1B/24h in equities, indices, commodities and FX.
# These are not crypto, so their asset class is assigned here rather than from
# CoinGecko (CL, SP500 and BRENTOIL are not listed coins).
BUILDER_COMMODITY = {"GOLD", "SILVER", "CL", "BRENTOIL", "NATGAS", "COPPER",
                     "PLATINUM", "PALLADIUM", "URNM"}
BUILDER_FX = {"JPY", "EUR", "GBP"}
BUILDER_INDEX = {"SP500", "XYZ100", "JP225", "KR200", "US500", "USTECH", "SMH",
                 "XLE", "EWY", "EWJ", "EWT", "EWZ", "BTCD", "TOTAL2"}


_crypto_ref = None


def crypto_ref():
    """Base symbols known to be crypto, so a builder dex listing BTC/ETH/HYPE
    (the `hyna` dex does) isn't mislabelled as an equity."""
    global _crypto_ref
    if _crypto_ref is None:
        ref = set()
        try:
            ref |= {u["name"] for u in hl_post({"type": "meta"})["universe"]}
        except Exception:
            pass
        try:
            info = get("/api/v3/exchangeInfo", {"permissions": "SPOT"})
            ref |= {s["baseAsset"] for s in info["symbols"] if s["quoteAsset"] == "USDT"}
        except Exception:
            pass
        _crypto_ref = ref
    return _crypto_ref


def builder_class(base):
    if base in BUILDER_COMMODITY:
        return "commodity"
    if base in BUILDER_FX:
        return "fx"
    if base in BUILDER_INDEX:
        return "index"
    if base in crypto_ref():
        return "crypto"
    return "equity"


def hl_dexs():
    """Builder dexs that currently list at least one market."""
    try:
        return [d["name"] for d in hl_post({"type": "perpDexs"}) if d and d.get("name")]
    except Exception as e:
        print(f"  perpDexs failed: {e}", file=sys.stderr)
        return []


def hl_universe(min_vol, top, dex=None):
    """Non-delisted HL perps above a 24h notional-volume floor, most liquid first.

    With `dex` set, queries a HIP-3 builder dex instead of the main perp dex. Builder
    market names already carry their prefix (e.g. "xyz:CL"), which is also the coin id
    candleSnapshot expects.
    """
    body = {"type": "metaAndAssetCtxs"}
    if dex:
        body["dex"] = dex
    meta, ctxs = hl_post(body)
    rows = []
    for u, c in zip(meta["universe"], ctxs):
        if u.get("isDelisted"):
            continue
        vol = float(c.get("dayNtlVlm") or 0)
        mark = float(c.get("markPx") or 0)
        if vol < min_vol or not mark:
            continue
        prev = float(c.get("prevDayPx") or 0)
        name = u["name"]
        base = name.split(":")[-1]
        row = {
            "symbol": name, "base": base,
            "venue": f"hl:{dex}" if dex else "hyperliquid",
            "quote_label": dex.upper() if dex else "PERP",
            "quote_vol_24h": vol,
            "change_24h": (mark - prev) / prev * 100 if prev else 0.0,
            "price": mark,
        }
        if dex:
            row["asset_class"] = builder_class(base)
            row["rwa"] = row["asset_class"] not in ("crypto",) and base not in ("BTCD", "TOTAL2")
        rows.append(row)
    rows.sort(key=lambda r: -r["quote_vol_24h"])
    return rows[:top] if top else rows


WEEK_MS = 604800000
DAY_MS = 86400000
# HL's daily backfill reaches ~2020; asking for more than this just wastes payload.
HL_MAX_DAILY = 2500


def week_start(ms):
    """Monday 00:00 UTC bucket for a timestamp - the week Binance and TradingView use."""
    return ms - (ms % DAY_MS) - time.gmtime(ms / 1000).tm_wday * DAY_MS


def resample_weekly(daily):
    """Fold daily klines into Monday-anchored weekly klines.

    HL buckets `1w` by raw epoch division and epoch 0 was a Thursday, so its native
    weekly candles run Thu->Wed while Binance and TradingView run Mon->Sun. Different
    weekly closes give different EMAs and different cross bars, so the HL weekly series
    is rebuilt from 1d rather than fetched. HL keeps ~1258 real daily bars (BTC back to
    2023-02), which is the same ~179 weeks its native 1w endpoint returns - no loss.
    """
    # A series starting mid-week would make its first weekly bar cover only part of that
    # week - wrong OHLC exactly where the EMA seed is most sensitive. Drop the stub.
    if daily and week_start(daily[0][0]) != daily[0][0]:
        first_full = week_start(daily[0][0]) + WEEK_MS
        daily = [k for k in daily if k[0] >= first_full]
    weeks = []
    for k in daily:
        ws = week_start(k[0])
        if weeks and weeks[-1][0] == ws:
            w = weeks[-1]
            w[2] = max(w[2], k[2])          # high
            w[3] = min(w[3], k[3])          # low
            w[4] = k[4]                     # close = last daily close in the week
            w[5] += k[5]                    # base volume
            w[7] += k[7]                    # quote volume
            w[8] += k[8]                    # trades
        else:
            weeks.append([ws, k[1], k[2], k[3], k[4], k[5],
                          ws + WEEK_MS - 1, k[7], k[8]])
    return weeks


def hl_klines(sym, tf, bars):
    """HL candles in Binance kline shape, with synthetic pre-listing bars removed.

    HL backfills candles from before a coin was listed - BTC weekly reaches 2019, four
    years before the exchange existed, and ZEC 1d returned 704 such bars out of 1001.
    They carry trades==0 and would silently poison an EMA200, so the leading run of
    zero-trade candles is trimmed. Interior zero-trade bars are kept: on an illiquid
    perp those are genuinely "no activity", and dropping them would distort bar spacing.

    Weekly is resampled from 1d - see resample_weekly for why the native 1w is unusable.
    """
    if tf == "1w":
        daily, lead = hl_klines(sym, "1d", min(bars * 7, HL_MAX_DAILY))
        return resample_weekly(daily), lead // 7
    ms = HL_MS[tf]
    now = int(time.time() * 1000)
    raw = hl_post({"type": "candleSnapshot",
                   "req": {"coin": sym, "interval": tf,
                           "startTime": now - bars * ms, "endTime": now}})
    lead = 0
    for k in raw:
        if int(k["n"]) == 0:
            lead += 1
        else:
            break
    raw = raw[lead:]
    out = []
    for k in raw:
        c = float(k["c"])
        v = float(k["v"])
        out.append([int(k["t"]), float(k["o"]), float(k["h"]), float(k["l"]), c,
                    v, int(k["T"]), v * c, int(k["n"])])
    return out, lead


def ema(values, period):
    """EMA seeded with the SMA of the first `period` values.

    Returns a list the same length as `values`, with None until the seed bar.
    """
    if len(values) < period:
        return [None] * len(values)
    out = [None] * (period - 1)
    prev = sum(values[:period]) / period
    out.append(prev)
    k = 2.0 / (period + 1)
    for v in values[period:]:
        prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


def universe(min_vol, top):
    """Tradeable USDT spot pairs above a 24h quote-volume floor, most liquid first."""
    info = get("/api/v3/exchangeInfo", {"permissions": "SPOT"})
    ok = set()
    for s in info["symbols"]:
        if s["status"] != "TRADING" or s["quoteAsset"] != "USDT":
            continue
        if s["baseAsset"] in STABLES:
            continue
        if s["symbol"].endswith(LEVERAGED):
            continue
        ok.add(s["symbol"])

    tickers = get("/api/v3/ticker/24hr")
    rows = []
    for t in tickers:
        if t["symbol"] not in ok:
            continue
        vol = float(t["quoteVolume"])
        if vol < min_vol:
            continue
        rows.append({
            "symbol": t["symbol"],
            "base": t["symbol"][:-4],
            "quote_vol_24h": vol,
            "change_24h": float(t["priceChangePercent"]),
            "price": float(t["lastPrice"]),
        })
    rows.sort(key=lambda r: -r["quote_vol_24h"])
    return rows[:top] if top else rows


# Which (timeframe, cross side) combinations survived out-of-sample validation in
# benchmark.py, and the score needed. Everything not listed here is noise - measured,
# not assumed. See README for the numbers behind each entry.
GRADED = {
    # (timeframe, side): (min_score, grade, direction)
    ("1d", "golden"): (3, "signal", "long"),
    ("4h", "death"):  (3, "contrarian", "mean-reversion long"),
}
# The benchmark measured forward returns over 20 bars, so a cross older than that is
# regime context, not a live signal.
SIGNAL_LIFE = 20

# Warmup needed before "no cross in this series" is a claim worth making, as a multiple
# of the slow period. Measured on 18 coins with 2400+ daily bars, comparing each
# truncated window against the cross found with full history (2208 judgements): a series
# with only 1.5x the slow period past its seed reports a false "no cross" 7.7% of the
# time and puts the cross on the wrong bar in 62% of cases. At 3.5x those fall to 0.6%
# and 12%. This matters most on Hyperliquid, which lists most coins years after Binance.
NO_CROSS_WARMUP = 3.5
BENCHMARKED_PRESET = "50/200"


def gates_at(f, s, diff, qv, ci, ai, warm, golden):
    """The four gates, evaluated AT the cross bar - no look-ahead."""
    w = 20
    # Need the slow EMA defined 20 bars back too, not just a valid index - on short
    # series a cross can sit close enough to the seed that s[ci-w] is still None.
    if ci - w < 0 or s[ci - w] is None or f[ci - w] is None:
        return None
    slow_slope = (s[ci] - s[ci - w]) / s[ci - w] * 100
    fast_slope = (f[ci] - f[ci - w]) / f[ci - w] * 100
    vol_avg = sum(qv[ci - w:ci]) / w or 1
    chop = 0
    for j in range(max(warm, ai - 100) + 1, ai):
        if (diff[j] > 0) != (diff[j - 1] > 0):
            chop += 1
    return {
        "trend":  slow_slope > 0 if golden else slow_slope < 0,
        "nochop": chop == 0,
        "volexp": qv[ci] / vol_avg >= 1.2,
        "momo":   fast_slope > 0 if golden else fast_slope < 0,
    }


def analyse(closes, highs, lows, times, fast_p, slow_p, qv=None, tf=None, preset=None):
    """Locate the most recent EMA cross and describe the current regime."""
    if len(closes) < slow_p + 5:
        return None
    f = ema(closes, fast_p)
    s = ema(closes, slow_p)

    # Only bars where both EMAs exist.
    start = slow_p - 1
    diff = [f[i] - s[i] for i in range(start, len(closes))]
    if len(diff) < 2:
        return None

    n = len(diff)
    last = n - 1
    bull = diff[last] > 0

    # The slow EMA is SMA-seeded, so right after the seed it still carries seed error
    # and can show the wrong sign - which invents crosses that never happened. Measured
    # against full history, these spurious crosses appear up to ~190 bars past the seed
    # for EMA200 and none beyond, so skip a warmup proportional to the slow period.
    # Short series (weekly) keep a 50-bar minimum search window rather than none.
    warm = min(int(1.25 * slow_p), max(0, n - 50))
    floor_i = max(1, warm)

    # Walk back to the last sign flip inside the warmed-up region. The range stops at
    # floor_i inclusive - excluding it dropped crosses sitting exactly on the warmup
    # boundary while search_bars still claimed to have covered them (FIL 1d).
    cross_at = None
    for i in range(last, floor_i - 1, -1):
        if (diff[i] > 0) != (diff[i - 1] > 0):
            cross_at = i
            break

    close = closes[-1]
    fast_v, slow_v = f[-1], s[-1]
    spread_now = (fast_v - slow_v) / slow_v * 100
    rec = {
        "state": "bull" if bull else "bear",
        "fast": fast_v,
        "slow": slow_v,
        # Signed EMA separation: how much conviction is behind the current regime.
        "spread_pct": spread_now,
        "close": close,
        "above_both": close > fast_v and close > slow_v,
        "bars_available": n,
        # How many bars the cross search actually covered, after the warmup skip.
        # Equals the largest bars_since the walk-back can return, so a cross reported
        # as N bars old is always <= this and the number never over-claims coverage.
        "search_bars": last - floor_i,
        # Bars of EMA evolution past the slow-EMA seed. Below ~1.5x the slow period the
        # slow EMA still carries seed error (measured: 0.8% at 300 bars past an EMA200 seed).
        "warmup_bars": n,
    }

    # Projected bars until the next cross, from how fast the spread is closing over
    # the last LOOK bars. A linear extrapolation, so it is an estimate - but it is
    # the actionable form of "how close is a cross", unlike |spread| which is just
    # the current separation restated.
    LOOK = 10
    rec["eta_bars"] = None
    if n > LOOK:
        j = len(closes) - 1
        jp = j - LOOK
        spread_prev = (f[jp] - s[jp]) / s[jp] * 100
        slope = (spread_now - spread_prev) / LOOK          # %-points per bar
        converging = (spread_now > 0 and slope < 0) or (spread_now < 0 and slope > 0)
        if converging and slope != 0:
            eta = abs(spread_now / slope)
            if eta <= 500:
                rec["eta_bars"] = round(eta, 1)

    if cross_at is None:
        # "no cross" and "we could not have seen one" are different claims. HL lists most
        # coins years after Binance, so its EMA200 is often seeded mid-trend and never
        # crosses inside the series at all - ALGO 1d shows a death cross on Binance and
        # nothing on HL. Grading both as "no cross" reads as "the regime held".
        rec.update({"cross": None, "bars_since": None,
                    "grade": "thin history" if n < NO_CROSS_WARMUP * slow_p else "no cross"})
        return rec

    ci = start + cross_at            # index into the closes array
    rec["cross"] = "golden" if bull else "death"
    rec["bars_since"] = last - cross_at
    rec["cross_time"] = times[ci]
    rec["cross_price"] = closes[ci]
    rec["pct_since_cross"] = (close - closes[ci]) / closes[ci] * 100
    # Max adverse/favourable excursion since the cross - did the signal hold?
    seg_h = max(highs[ci:])
    seg_l = min(lows[ci:])
    rec["mfe_pct"] = (seg_h - closes[ci]) / closes[ci] * 100
    rec["mae_pct"] = (seg_l - closes[ci]) / closes[ci] * 100

    # Signal vs noise, per the out-of-sample benchmark.
    g = gates_at(f, s, diff, qv, ci, cross_at, warm, bull) if qv else None
    if g is None:
        rec["grade"] = "unknown"
        return rec
    rec["gates"] = g
    rec["score"] = sum(1 for v in g.values() if v)
    need = GRADED.get((tf, rec["cross"]))
    if preset != BENCHMARKED_PRESET:
        # Only 50/200 was benchmarked; 21/55 gets a score but no verdict.
        rec["grade"] = "unvalidated"
    elif rec["warmup_bars"] < 1.5 * slow_p:
        # Too few bars past the slow-EMA seed for the EMA itself to be trustworthy -
        # refuse to call it a signal rather than grade an uncertain number.
        rec["grade"] = "thin history"
    elif rec["bars_since"] > SIGNAL_LIFE:
        rec["grade"] = "expired"
    elif need and rec["score"] >= need[0]:
        rec["grade"], rec["direction"] = need[1], need[2]
    else:
        rec["grade"] = "noise"
    return rec


SCAN_AS_OF = [None]


def scan_one(venue, sym, tf):
    """Fetch one symbol/timeframe and analyse every preset. Drops the live bar."""
    trimmed = 0
    try:
        if venue == "hyperliquid" or venue.startswith("hl:"):
            kl, trimmed = hl_klines(sym, tf, BARS)
        else:
            kl = get("/api/v3/klines", {"symbol": sym, "interval": tf, "limit": BARS})
    except Exception as e:
        return sym, tf, {"bars": 0, "error": str(e)}
    if len(kl) < 2:
        return sym, tf, {"bars": 0, "note": "no closed bars"}

    # Closed bars only, cut at a single instant shared by every venue. Venues are scanned
    # sequentially and HL is throttled to 4 workers, so it finished ~1h after Binance and
    # picked up one extra 1h bar - 89 of 113 overlapping 1h rows disagreed on bars_since
    # by exactly 1, same cross_time. Dropping just the last bar per series hid that.
    as_of = SCAN_AS_OF[0] or int(time.time() * 1000)
    kl = [k for k in kl if int(k[6]) <= as_of]
    if len(kl) < 2:
        return sym, tf, {"bars": 0, "note": "no closed bars"}
    times = [int(k[0]) for k in kl]
    closes = [float(k[4]) for k in kl]
    highs = [float(k[2]) for k in kl]
    lows = [float(k[3]) for k in kl]
    qv = [float(k[7]) for k in kl]

    out = {"bars": len(kl), "last_close_time": int(kl[-1][6]),
           "lo": min(closes), "hi": max(closes)}
    if trimmed:
        out["synthetic_trimmed"] = trimmed
    for name, (fp, sp) in PRESETS.items():
        try:
            out[name] = analyse(closes, highs, lows, times, fp, sp, qv, tf, name)
        except Exception as e:
            # One malformed series must not abort a whole scan.
            out[name] = None
            out.setdefault("errors", []).append(f"{name}: {e}")
    return sym, tf, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-vol", type=float, default=100_000,
                    help="minimum 24h quote volume in USDT (default 100k - scan wide, "
                         "filter for liquidity in the dashboard)")
    ap.add_argument("--top", type=int, default=0, help="cap universe size (0 = no cap)")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--venue", default="all",
                    choices=["binance", "hyperliquid", "builder", "all"],
                    help="binance spot, hyperliquid main perps, HIP-3 builder dexs "
                         "(trade.xyz etc), or all (default)")
    args = ap.parse_args()

    t0 = time.time()
    SCAN_AS_OF[0] = int(t0 * 1000)
    if args.venue == "all":
        venues = ["binance", "hyperliquid"] + [f"hl:{d}" for d in hl_dexs()]
    elif args.venue == "builder":
        venues = [f"hl:{d}" for d in hl_dexs()]
    else:
        venues = [args.venue]

    rows, empty = [], []
    for venue in venues:
        if venue.startswith("hl:"):
            coins = hl_universe(args.min_vol, args.top, dex=venue[3:])
            if not coins:
                print(f"{venue}: no markets above floor, skipping", file=sys.stderr)
                empty.append(venue)
                continue
        elif venue == "hyperliquid":
            coins = hl_universe(args.min_vol, args.top)
        else:
            coins = universe(args.min_vol, args.top)
            for c in coins:
                c["venue"], c["quote_label"] = "binance", "USDT"
        print(f"{venue}: {len(coins)} markets (24h vol >= ${args.min_vol:,.0f})",
              file=sys.stderr)

        tasks = [(venue, c["symbol"], tf) for c in coins for tf in TIMEFRAMES]
        # HL's info endpoint is far tighter than Binance's weight budget.
        workers = args.workers if venue == "binance" else min(args.workers, 4)
        results, done = {}, 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for sym, tf, rec in pool.map(lambda a: scan_one(*a), tasks):
                results.setdefault(sym, {})[tf] = rec
                done += 1
                if done % 200 == 0:
                    print(f"  {venue} {done}/{len(tasks)}", file=sys.stderr)

        # HL's endpoint sheds a small share of concurrent requests no matter how gently
        # they are paced. Retry just the failures, sequentially, so a scan finishes whole.
        failed = [(sym, tf) for sym, tfs in results.items()
                  for tf, v in tfs.items() if "error" in v]
        if failed:
            print(f"  retrying {len(failed)} failed series sequentially", file=sys.stderr)
            for sym, tf in failed:
                _, _, rec = scan_one(venue, sym, tf)
                if "error" not in rec:
                    results[sym][tf] = rec

        for c in coins:
            r = dict(c)
            r["tf"] = results.get(c["symbol"], {})
            rows.append(r)

    # Drop pegged assets: an EMA cross on a stablecoin is meaningless. Detected from
    # the price history rather than a hardcoded ticker list, so newly listed
    # stablecoins are caught without maintenance (this found U, BFUSD and USDE).
    def pegged(r):
        for tf in ("1d", "12h", "4h", "1h"):
            v = r["tf"].get(tf) or {}
            if v.get("lo"):
                return v["lo"] > 0.98 and v["hi"] < 1.02
        return False

    dropped = sorted(r["base"] for r in rows if pegged(r))
    rows = [r for r in rows if not pegged(r)]
    print(f"excluded {len(dropped)} pegged assets: {', '.join(dropped)}", file=sys.stderr)

    # Sector / asset-class tags. The rules in GRADED were validated on crypto only, so
    # a tokenized equity or commodity must not inherit a crypto-derived verdict.
    try:
        classify = sectors.classify(sectors.load())
    except Exception as e:
        print(f"sector tags unavailable: {e}", file=sys.stderr)
        classify = None
    klass = {}
    if classify:
        for r in rows:
            if "asset_class" not in r:   # builder dexs already classified explicitly
                cls, is_rwa = classify(r["base"])
                r["asset_class"], r["rwa"] = cls, is_rwa
            cls = r["asset_class"]
            klass[cls] = klass.get(cls, 0) + 1
            if cls != "crypto":
                for v in r["tf"].values():
                    for p in PRESETS:
                        rec = (v or {}).get(p)
                        if rec and rec.get("grade") in ("signal", "contrarian"):
                            rec["grade"] = "unvalidated class"
        print(f"asset classes: {klass} | RWA-tagged: {sum(1 for r in rows if r.get('rwa'))}",
              file=sys.stderr)

    # GRADED was fitted on Binance spot. Re-running the same measurement on HL's own
    # deep history, the composite rule does not survive out of sample there: 1d golden
    # score>=3 is +11.99pp in the early half of HL history and -2.96pp in the late half
    # (n=25, P(edge<=0)=0.73), and 4h death is +2.81pp early, -0.29pp late (n=229,
    # P=0.57). Requiring volume does not rescue it (-0.72pp, P=0.77). Same principle as
    # `unvalidated class`: the verdict was not benchmarked on this population, so none
    # is claimed. The score and gates are still reported.
    n_uv = 0
    for r in rows:
        if r["venue"] == "binance":
            continue
        for v in r["tf"].values():
            for p in PRESETS:
                rec = (v or {}).get(p)
                if rec and rec.get("grade") in ("signal", "contrarian"):
                    rec["grade"] = "unvalidated venue"
                    n_uv += 1
    print(f"venue-unvalidated verdicts withheld: {n_uv}", file=sys.stderr)

    synth = sum(1 for c in rows for v in c["tf"].values() if v.get("synthetic_trimmed"))
    payload = {
        "excluded_pegged": dropped,
        "generated_at": int(time.time() * 1000),
        "source": " + ".join(
            {"binance": "Binance spot (api.binance.com)",
             "hyperliquid": "Hyperliquid perps (api.hyperliquid.xyz)"}.get(
                v, f"Hyperliquid HIP-3 builder dex '{v[3:]}'")
            for v in venues if v not in empty),
        "venues": [v for v in venues if v not in empty],
        "synthetic_series_trimmed": synth,
        "timeframes": TIMEFRAMES,
        "presets": {k: list(v) for k, v in PRESETS.items()},
        "min_vol": args.min_vol,
        "bars_requested": BARS,
        "coins": rows,
    }
    DATA.mkdir(exist_ok=True)
    out = DATA / "scan.json"
    tmp = DATA / "scan.json.tmp"
    tmp.write_text(json.dumps(payload, separators=(",", ":")))
    tmp.replace(out)

    errs = sum(1 for c in rows for v in c["tf"].values() if "error" in v)
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB) "
          f"in {time.time() - t0:.0f}s, {errs} fetch errors", file=sys.stderr)


if __name__ == "__main__":
    main()
