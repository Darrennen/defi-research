#!/usr/bin/env python3
"""
Hermes Trading Engine — Polymarket BTC "Up or Down" 5-minute scalper
────────────────────────────────────────────────────────────────────
Strategy (mirrors lib/hermes.ts so the dashboard and trader agree):
  1. 3-state Markov regime model (Bull/Bear/Side) fit on recent BTC returns
  2. 500-path Monte Carlo simulation to the market's resolution horizon
  3. Pattern scanner (liquidity sweep / order block / FVG) for confirmation
  4. Edge vs the live CLOB price → fractional-Kelly position sizing
With full safety rails: daily spend cap, max positions, min edge, wallet floor,
stop on low balance, one position per round. Settles P&L after each round and
publishes realized stats to Redis for the dashboard.

Usage:
  python3 hermes.py --scan     # print the live model + signal, no trading
  python3 hermes.py            # dry-run loop (paper trades, default)
  python3 hermes.py --live     # REAL trading (only after dry-run looks right)
  python3 hermes.py --stop     # emergency: cancel all open orders and exit

Requirements:
  pip install py-clob-client-v2 python-dotenv     # (only needed for --live)
"""

import argparse
import json
import logging
import math
import os
import random
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ── optional deps ──────────────────────────────────────────────────────────────
try:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import MarketOrderArgs, OrderType
    from py_clob_client.order_builder.constants import BUY
    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

# ── config ───────────────────────────────────────────────────────────────────
ASSET              = os.getenv("HERMES_ASSET", "btc").lower()
BANKROLL           = float(os.getenv("HERMES_BANKROLL", "200"))
KELLY_FRACTION     = float(os.getenv("HERMES_KELLY_FRACTION", "0.25"))
MIN_EDGE           = float(os.getenv("HERMES_MIN_EDGE", "0.05"))    # 5%
MAX_SINGLE_BET     = float(os.getenv("HERMES_MAX_BET", "30"))
MAX_DAILY_SPEND    = float(os.getenv("HERMES_MAX_DAILY", "120"))
MIN_WALLET_BALANCE = float(os.getenv("HERMES_MIN_BALANCE", "10"))
MC_PATHS           = int(os.getenv("HERMES_MC_PATHS", "500"))
LOOP_SLEEP         = int(os.getenv("HERMES_LOOP_SEC", "20"))

GAMMA = "https://gamma-api.polymarket.com"
CLOB  = "https://clob.polymarket.com"
CHAIN_ID = 137

BINANCE_SYMBOL = {"btc": "BTCUSDT", "eth": "ETHUSDT", "sol": "SOLUSDT",
                  "xrp": "XRPUSDT", "doge": "DOGEUSDT"}
COINBASE_SYMBOL = {"btc": "BTC-USD", "eth": "ETH-USD", "sol": "SOL-USD",
                   "xrp": "XRP-USD", "doge": "DOGE-USD"}

LOG_FILE   = Path(__file__).parent / "hermes_trades.log"
STATE_FILE = Path(__file__).parent / "hermes_state.json"

DRY_RUN = True   # flipped by --live

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    handlers=[logging.StreamHandler(), logging.FileHandler(LOG_FILE)])
log = logging.getLogger("hermes")


# ── http helpers ───────────────────────────────────────────────────────────────
def get_json(url, timeout=15):
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "hermes/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def fetch_candles(asset, limit=300):
    """Recent 1-minute candles as list of dicts, with multi-source fallback."""
    sym = BINANCE_SYMBOL.get(asset, "BTCUSDT")
    for host in ("https://api.binance.com", "https://api.binance.us"):
        try:
            rows = get_json(f"{host}/api/v3/klines?symbol={sym}&interval=1m&limit={limit}")
            cs = [{"t": r[0], "o": float(r[1]), "h": float(r[2]), "l": float(r[3]),
                   "c": float(r[4]), "v": float(r[5])} for r in rows]
            if len(cs) > 30:
                return cs, host.split("//")[1]
        except Exception:
            continue
    # coinbase fallback
    try:
        csym = COINBASE_SYMBOL.get(asset, "BTC-USD")
        rows = get_json(f"https://api.exchange.coinbase.com/products/{csym}/candles?granularity=60")
        cs = [{"t": r[0] * 1000, "l": float(r[1]), "h": float(r[2]), "o": float(r[3]),
               "c": float(r[4]), "v": float(r[5])} for r in rows]
        cs.sort(key=lambda x: x["t"])
        return cs[-limit:], "coinbase"
    except Exception as e:
        raise RuntimeError(f"all price sources failed: {e}")


# ── math: returns, regimes, markov, monte carlo, patterns ────────────────────────
def log_returns(candles):
    return [math.log(candles[i]["c"] / candles[i - 1]["c"]) for i in range(1, len(candles))]


def _mean(xs): return sum(xs) / len(xs) if xs else 0.0
def _std(xs):
    if len(xs) < 2: return 0.0
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


REGIMES = ["bull", "bear", "side"]


def label_regimes(returns, win=10, theta=0.35):
    sigma = _std(returns) or 1e-9
    labels = []
    for i in range(len(returns)):
        lo = max(0, i - win + 1)
        m = _mean(returns[lo:i + 1])
        if m > theta * sigma: labels.append("bull")
        elif m < -theta * sigma: labels.append("bear")
        else: labels.append("side")
    return labels


def fit_markov(returns, labels):
    idx = {"bull": 0, "bear": 1, "side": 2}
    counts = [[1, 1, 1], [1, 1, 1], [1, 1, 1]]   # Laplace smoothing
    for i in range(1, len(labels)):
        counts[idx[labels[i - 1]]][idx[labels[i]]] += 1
    P = [[c / sum(row) for c in row] for row in counts]

    pi = [1 / 3, 1 / 3, 1 / 3]
    for _ in range(500):
        nxt = [sum(pi[i] * P[i][j] for i in range(3)) for j in range(3)]
        s = sum(nxt) or 1
        pi = [x / s for x in nxt]

    stats = {}
    for reg in REGIMES:
        rs = [returns[i] for i in range(len(returns)) if labels[i] == reg]
        stats[reg] = {"mu": _mean(rs), "sigma": _std(rs) or _std(returns) or 1e-6, "n": len(rs)}

    return {"P": P, "stationary": {"bull": pi[0], "bear": pi[1], "side": pi[2]},
            "current": labels[-1] if labels else "side", "stats": stats}


def monte_carlo(model, spot, price_to_beat, horizon, paths=MC_PATHS):
    H = max(1, min(horizon, 240))
    ridx = {"bull": 0, "bear": 1, "side": 2}
    finals = []
    for _ in range(paths):
        price, reg = spot, model["current"]
        for _ in range(H):
            row = model["P"][ridx[reg]]
            u, acc, nxt = random.random(), 0.0, 2
            for j in range(3):
                acc += row[j]
                if u <= acc:
                    nxt = j; break
            reg = REGIMES[nxt]
            st = model["stats"][reg]
            price *= math.exp(st["mu"] + st["sigma"] * random.gauss(0, 1))
        finals.append(price)
    up = sum(1 for f in finals if f > price_to_beat)
    p_up = up / paths
    return {"p_up": p_up, "p_down": 1 - p_up, "mean_final": _mean(finals),
            "mean_delta": _mean(finals) - price_to_beat, "horizon": H, "paths": paths}


def scan_patterns(c):
    out = []
    n = len(c)
    # liquidity sweep
    if n >= 12:
        win = c[n - 11:n - 1]; last = c[n - 1]
        ph, pl = max(x["h"] for x in win), min(x["l"] for x in win)
        if last["h"] > ph and last["c"] < ph: out.append(("Liquidity Sweep", "down", 0.6))
        elif last["l"] < pl and last["c"] > pl: out.append(("Liquidity Sweep", "up", 0.6))
        else: out.append(("Liquidity Sweep", "none", 0.2))
    # order block
    if n >= 6:
        sigma = _std(log_returns(c[-30:])) or 1e-9
        imp = math.log(c[n - 1]["c"] / c[n - 1]["o"])
        ob = c[n - 2]
        if abs(imp) > 1.6 * sigma:
            bull = imp > 0; ob_bull = ob["c"] > ob["o"]
            if bull and not ob_bull: out.append(("Order Block", "up", 0.7))
            elif not bull and ob_bull: out.append(("Order Block", "down", 0.7))
            else: out.append(("Order Block", "none", 0.25))
        else:
            out.append(("Order Block", "none", 0.25))
    # FVG
    if n >= 3:
        a, d = c[n - 3], c[n - 1]
        if d["l"] > a["h"]: out.append(("FVG", "up", 0.6))
        elif a["l"] > d["h"]: out.append(("FVG", "down", 0.6))
        else: out.append(("FVG", "none", 0.2))
    return out


def kelly_stake(p_model, price_prob, bankroll, fraction=KELLY_FRACTION, cap=MAX_SINGLE_BET):
    if price_prob <= 0 or price_prob >= 1: return 0.0
    b = (1 - price_prob) / price_prob
    f = (p_model * b - (1 - p_model)) / b
    return min(max(0.0, f * fraction * bankroll), cap)


# ── live market discovery ────────────────────────────────────────────────────────
def clob_midpoint(token_id):
    try:
        d = get_json(f"{CLOB}/midpoint?token_id={token_id}")
        mid = d.get("mid") or d.get("price")
        return float(mid) if mid is not None else None
    except Exception:
        return None


def fetch_live_pulse(asset="btc"):
    data = get_json(f"{GAMMA}/markets?closed=false&limit=400&order=startDate&ascending=false")
    markets = data if isinstance(data, list) else data.get("data", [])
    prefix = f"{asset}-updown-5m"
    now = time.time() * 1000
    cands = []
    for m in markets:
        slug = m.get("slug", "")
        if not slug.startswith(prefix):
            continue
        end = m.get("endDate")
        try:
            end_ms = datetime.fromisoformat(end.replace("Z", "+00:00")).timestamp() * 1000
        except Exception:
            continue
        if end_ms > now:
            cands.append((end_ms, m))
    if not cands:
        return None
    cands.sort(key=lambda x: x[0])
    end_ms, m = cands[0]
    try:
        token_ids = json.loads(m.get("clobTokenIds", "[]"))
    except Exception:
        token_ids = []
    if len(token_ids) < 2:
        return None
    slug_ts = int(m["slug"].split("-")[-1])
    up = clob_midpoint(token_ids[0])
    dn = clob_midpoint(token_ids[1])
    if up is None and dn is not None: up = 1 - dn
    if dn is None and up is not None: dn = 1 - up
    return {"slug": m["slug"], "question": m.get("question", ""), "window_start": slug_ts,
            "end_ms": end_ms, "up_token": token_ids[0], "down_token": token_ids[1],
            "up_price": up or 0.5, "down_price": dn or 0.5}


def price_to_beat_for(candles, window_start_sec, spot):
    if not window_start_sec:
        return spot
    start_ms = window_start_sec * 1000
    best = None
    for c in candles:
        if c["t"] == start_ms:
            return c["o"]
        if c["t"] <= start_ms and (best is None or c["t"] > best["t"]):
            best = c
    return best["c"] if best else spot


# ── analyze: produce the full signal for the current round ─────────────────────
def analyze():
    candles, source = fetch_candles(ASSET, 300)
    spot = candles[-1]["c"]
    returns = log_returns(candles)
    labels = label_regimes(returns)
    markov = fit_markov(returns, labels)
    patterns = scan_patterns(candles)
    pulse = fetch_live_pulse(ASSET)

    # 5-min rounds are timed by their window [start, start+300]. Edge exists only
    # once a round is LIVE (open price known); before that it's a ~50/50 flip.
    now_ms = time.time() * 1000
    win_start = pulse["window_start"] * 1000 if pulse else 0
    win_end = win_start + 300_000
    is_live = bool(pulse) and win_start <= now_ms < win_end
    phase = "none" if not pulse else "live" if is_live else ("upcoming" if now_ms < win_start else "settling")

    if is_live:
        ptb = price_to_beat_for(candles, pulse["window_start"], spot)
        secs_left = max(0, (win_end - now_ms) / 1000)
        horizon = max(1, math.ceil(secs_left / 60))
    elif pulse:
        ptb = spot
        secs_left = max(0, (win_start - now_ms) / 1000)   # time until the round starts
        horizon = 5
    else:
        ptb, secs_left, horizon = spot, 0, 5

    mc = monte_carlo(markov, spot, ptb, horizon)

    up_price = pulse["up_price"] if pulse else 0.5
    down_price = pulse["down_price"] if pulse else 0.5
    up_edge = mc["p_up"] - up_price
    down_edge = mc["p_down"] - down_price

    side, edge, p_model, mkt = "NONE", 0.0, 0.0, 0.0
    if is_live and up_edge >= down_edge and up_edge > 0:
        side, edge, p_model, mkt = "UP", up_edge, mc["p_up"], up_price
    elif is_live and down_edge > 0:
        side, edge, p_model, mkt = "DOWN", down_edge, mc["p_down"], down_price

    stake = kelly_stake(p_model, mkt, BANKROLL) if mkt > 0 else 0.0
    agree = sum(1 for (_, d, _) in patterns
                if (side == "UP" and d == "up") or (side == "DOWN" and d == "down"))

    return {"source": source, "spot": spot, "ptb": ptb, "secs_left": secs_left,
            "phase": phase, "is_live": is_live,
            "markov": markov, "mc": mc, "patterns": patterns, "pulse": pulse,
            "side": side, "edge": edge, "p_model": p_model, "market_price": mkt,
            "stake": stake, "agree": agree}


def print_signal(a):
    mc, mk = a["mc"], a["markov"]
    print("\n" + "─" * 72)
    print(f"  HERMES · {ASSET.upper()} 5min Pulse · source={a['source']}")
    print("─" * 72)
    if a["pulse"]:
        print(f"  Market : {a['pulse']['question']}  [{a['phase'].upper()}]")
        when = "resolves in" if a["is_live"] else "starts in"
        print(f"  {when} : {int(a['secs_left'])}s   UP {a['pulse']['up_price']*100:.0f}¢ / DOWN {a['pulse']['down_price']*100:.0f}¢")
    print(f"  Price to beat : ${a['ptb']:,.2f}   spot ${a['spot']:,.2f}   Δ {a['spot']-a['ptb']:+,.2f}")
    print(f"  Regime now : {mk['current'].upper()}   π={ {k: round(v,2) for k,v in mk['stationary'].items()} }")
    print(f"  Monte Carlo ({mc['paths']}p, {mc['horizon']}m): P(UP)={mc['p_up']*100:.0f}%  P(DOWN)={mc['p_down']*100:.0f}%  meanΔ={mc['mean_delta']:+.2f}")
    print(f"  Patterns : " + ", ".join(f"{n}:{d}" for n, d, _ in a["patterns"]))
    print(f"  SIGNAL : {a['side']}  edge={a['edge']*100:+.1f}%  model={a['p_model']*100:.0f}%  "
          f"mkt={a['market_price']*100:.0f}¢  stake=${a['stake']:.2f}  agree={a['agree']}/3")
    print("─" * 72 + "\n")


# ── state + redis publish (for the dashboard) ────────────────────────────────────
def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"realizedPnl": 0.0, "trades": 0, "wins": 0, "winRate": 0.0,
            "biggestWin": 0.0, "dayPnl": 0.0, "day": "", "daily_spend": 0.0,
            "open": {}, "wallet": os.getenv("WALLET_ADDRESS"), "mode": "dry"}


def save_state(s):
    STATE_FILE.write_text(json.dumps(s, indent=2))
    publish_redis(s)


def publish_redis(s):
    url = os.getenv("UPSTASH_REDIS_REST_URL")
    tok = os.getenv("UPSTASH_REDIS_REST_TOKEN")
    if not url or not tok:
        return
    try:
        payload = {"realizedPnl": s["realizedPnl"], "trades": s["trades"],
                   "winRate": s["winRate"], "biggestWin": s["biggestWin"],
                   "dayPnl": s["dayPnl"], "wallet": s.get("wallet"), "mode": s.get("mode"),
                   "updatedAt": datetime.now(timezone.utc).isoformat()}
        body = json.dumps(["SET", "hermes:state", json.dumps(payload)]).encode()
        req = urllib.request.Request(url, data=body,
                                     headers={"Authorization": f"Bearer {tok}",
                                              "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        log.warning(f"redis publish failed: {e}")


def today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def roll_day(s):
    if s.get("day") != today():
        s["day"] = today(); s["dayPnl"] = 0.0; s["daily_spend"] = 0.0


# ── trading ──────────────────────────────────────────────────────────────────────
def init_client():
    if not SDK_AVAILABLE:
        log.error("py-clob-client-v2 not installed. Run: pip install py-clob-client-v2")
        sys.exit(1)
    key, funder = os.getenv("PRIVATE_KEY"), os.getenv("WALLET_ADDRESS")
    if not key or not funder:
        log.error("PRIVATE_KEY and WALLET_ADDRESS must be set in .env")
        sys.exit(1)
    client = ClobClient(CLOB, key=key, chain_id=CHAIN_ID, signature_type=1, funder=funder)
    client.set_api_creds(client.create_or_derive_api_creds())
    log.info(f"client ready — funder {funder[:8]}…")
    return client


def safety_block(a, s, client):
    if not a["is_live"]:
        return f"round not live ({a['phase']})"
    if a["side"] == "NONE":
        return "no positive edge"
    if a["edge"] < MIN_EDGE:
        return f"edge {a['edge']:.1%} < min {MIN_EDGE:.0%}"
    if a["stake"] < 1.0:
        return f"stake ${a['stake']:.2f} below $1 minimum"
    if s["daily_spend"] + a["stake"] > MAX_DAILY_SPEND:
        return f"daily spend cap ${MAX_DAILY_SPEND} would be exceeded"
    if a["pulse"]["slug"] in s.get("open", {}):
        return "already positioned in this round"
    if client:
        try:
            bal = float(client.get_usdc_balance() or 0)
            if bal < MIN_WALLET_BALANCE + a["stake"]:
                return f"wallet ${bal:.2f} below floor"
        except Exception:
            pass
    return None


def place_bet(client, a, s):
    pulse = a["pulse"]
    token = pulse["up_token"] if a["side"] == "UP" else pulse["down_token"]
    label = f"{ASSET.upper()} {a['side']} · {pulse['slug']}"
    if DRY_RUN:
        log.info(f"DRY-BET  {label}  ${a['stake']:.2f} @ {a['market_price']*100:.0f}¢  edge {a['edge']:+.1%}")
        record_open(s, a, paper=True)
        return
    try:
        order = MarketOrderArgs(token_id=token, amount=a["stake"], side=BUY, order_type=OrderType.FOK)
        signed = client.create_market_order(order)
        resp = client.post_order(signed, OrderType.FOK)
        if resp.get("success"):
            log.info(f"BET {label}  ${a['stake']:.2f} @ {a['market_price']*100:.0f}¢")
            record_open(s, a, paper=False)
        else:
            log.warning(f"order rejected: {resp}")
    except Exception as e:
        log.error(f"order failed {label}: {e}")


def record_open(s, a, paper):
    s.setdefault("open", {})[a["pulse"]["slug"]] = {
        "side": a["side"], "stake": a["stake"], "price": a["market_price"],
        "ptb": a["ptb"], "end_ms": a["pulse"]["end_ms"], "paper": paper,
        "opened": datetime.now(timezone.utc).isoformat(),
    }
    s["daily_spend"] = s.get("daily_spend", 0.0) + a["stake"]
    save_state(s)


def settle_rounds(s):
    """Resolve finished rounds against the actual BTC outcome and book P&L."""
    open_rounds = s.get("open", {})
    if not open_rounds:
        return
    candles, _ = fetch_candles(ASSET, 300)
    now = time.time() * 1000
    done = []
    for slug, pos in open_rounds.items():
        if now < pos["end_ms"] + 30_000:   # wait 30s past resolution for the close
            continue
        # final price at/after window end
        end_sec = pos["end_ms"] / 1000
        final = None
        for c in candles:
            if c["t"] / 1000 >= end_sec - 60:
                final = c["c"]
        if final is None:
            final = candles[-1]["c"]
        went_up = final > pos["ptb"]
        won = (pos["side"] == "UP" and went_up) or (pos["side"] == "DOWN" and not went_up)
        stake, price = pos["stake"], pos["price"]
        pnl = stake * (1 - price) / price if won else -stake
        s["realizedPnl"] = s.get("realizedPnl", 0.0) + pnl
        s["dayPnl"] = s.get("dayPnl", 0.0) + pnl
        s["trades"] = s.get("trades", 0) + 1
        if won:
            s["wins"] = s.get("wins", 0) + 1
            s["biggestWin"] = max(s.get("biggestWin", 0.0), pnl)
        s["winRate"] = round(100 * s.get("wins", 0) / s["trades"], 1)
        log.info(f"SETTLE {slug} {pos['side']} {'WIN' if won else 'LOSS'} pnl={pnl:+.2f} "
                 f"(final ${final:,.2f} vs ${pos['ptb']:,.2f})")
        done.append(slug)
    for slug in done:
        open_rounds.pop(slug, None)
    if done:
        save_state(s)


# ── main ───────────────────────────────────────────────────────────────────────
def main():
    global DRY_RUN
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="real trading")
    ap.add_argument("--scan", action="store_true", help="print signal only")
    ap.add_argument("--stop", action="store_true", help="cancel all orders and exit")
    args = ap.parse_args()

    if args.scan:
        print_signal(analyze())
        return

    if args.stop:
        client = init_client()
        try:
            client.cancel_all(); log.info("all orders cancelled")
        except Exception as e:
            log.error(f"cancel_all failed: {e}")
        return

    if args.live:
        DRY_RUN = False
        log.warning("⚠️  LIVE MODE — real money will be traded")

    s = load_state()
    s["mode"] = "dry" if DRY_RUN else "live"
    s["wallet"] = os.getenv("WALLET_ADDRESS")
    client = init_client() if not DRY_RUN else None
    save_state(s)

    log.info(f"Hermes started — {'DRY-RUN' if DRY_RUN else 'LIVE'} · bankroll ${BANKROLL} · "
             f"kelly {KELLY_FRACTION} · min edge {MIN_EDGE:.0%}")

    while True:
        roll_day(s)
        try:
            settle_rounds(s)
            a = analyze()
            print_signal(a)
            if a["pulse"]:
                block = safety_block(a, s, client)
                if block:
                    log.info(f"SKIP {a['side']}: {block}")
                else:
                    place_bet(client, a, s)
        except Exception as e:
            log.error(f"loop error: {e}")
        time.sleep(LOOP_SLEEP)


if __name__ == "__main__":
    main()
