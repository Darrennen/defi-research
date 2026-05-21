#!/usr/bin/env python3
"""
Yield Tracker — backend server
Run:  python3 server.py
Open: http://localhost:8765
"""

import json
import threading
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

# ── Config ───────────────────────────────────────────────────────────────────

CAPITAL         = 4100
HF              = 2.0
GAS_SIMPLE      = 35
GAS_LOOP        = 150
REFRESH_SEC     = 300
HISTORY_MAX     = 24     # readings to keep per market (~2h at 5min interval)

PENDLE_CHAIN    = 1
PENDLE_MIN_LIQ  = 500_000
PENDLE_MIN_DAYS = 5

MORPHO_GQL            = "https://blue-api.morpho.org/graphql"
MORPHO_MIN_LIQ        = 10_000
MORPHO_LENDING_MIN_LIQ = 500_000

# ── Global state ─────────────────────────────────────────────────────────────

_state   = {"data": None, "updated_at": None, "error": None}
_history = defaultdict(list)   # market_id → [{ts, borrow_apy, utilization}]
_lock    = threading.Lock()

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def get_json(url, timeout=25):
    req = urllib.request.Request(url, headers={
        "Accept": "application/json", "User-Agent": "Mozilla/5.0"
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def post_json(url, payload, timeout=30):
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

# ── Gas price ─────────────────────────────────────────────────────────────────

def fetch_gas():
    """Get current Ethereum gas price via public RPC + ETH price via CoinGecko."""
    result = {}
    # Gas via ETH RPC
    try:
        resp = post_json("https://eth.llamarpc.com", {
            "jsonrpc": "2.0", "method": "eth_gasPrice", "params": [], "id": 1
        })
        wei  = int(resp["result"], 16)
        gwei = wei / 1e9
        result["gwei"] = round(gwei, 2)
    except Exception as e:
        result["gwei"] = None
        result["gwei_error"] = str(e)

    # ETH price
    try:
        d = get_json("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
        result["eth_usd"] = d.get("ethereum", {}).get("usd")
    except Exception:
        result["eth_usd"] = None

    # Estimate USD cost per strategy
    if result.get("gwei") and result.get("eth_usd"):
        gwei    = result["gwei"]
        eth_usd = result["eth_usd"]
        # gas units: simple PT ~200k, loop iteration ~450k, 3 loops ~1.35M
        result["cost_simple"] = round(200_000 * gwei * 1e-9 * eth_usd, 2)
        result["cost_loop"]   = round(1_350_000 * gwei * 1e-9 * eth_usd, 2)

    return result

# ── apxUSD peg ────────────────────────────────────────────────────────────────

def fetch_peg():
    try:
        d = get_json(
            "https://api.coingecko.com/api/v3/simple/price"
            "?ids=apxusd&vs_currencies=usd&include_24hr_change=true"
        )
        info = d.get("apxusd", {})
        if info:
            return {
                "price":     info.get("usd"),
                "change_24h": round(info.get("usd_24h_change") or 0, 4),
                "status":    "ok" if (info.get("usd") or 1) >= 0.995 else "depeg",
            }
    except Exception:
        pass
    return {"price": None, "change_24h": None, "status": "unknown"}

# ── Pendle ────────────────────────────────────────────────────────────────────

def fetch_pendle():
    url  = (f"https://api-v2.pendle.finance/core/v1/{PENDLE_CHAIN}/markets"
            f"?skip=0&limit=50")
    data = get_json(url)
    now  = datetime.now(timezone.utc)
    results = []
    for m in data.get("results", []):
        if not m.get("isActive", True):
            continue
        implied_apy = m.get("impliedApy") or 0
        if implied_apy <= 0:
            continue
        expiry_str = m.get("expiry", "")
        days_left  = None
        if expiry_str:
            try:
                exp       = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
                days_left = max(0, (exp - now).days)
            except Exception:
                pass
        if days_left is not None and days_left < PENDLE_MIN_DAYS:
            continue
        liq_usd = (m.get("liquidity") or {}).get("usd") or 0
        if liq_usd < PENDLE_MIN_LIQ:
            continue
        gross    = CAPITAL * implied_apy * (days_left / 365) if days_left else 0
        pt       = m.get("pt") or {}
        pt_price = (pt.get("price") or {}).get("usd")

        underlying_apy   = m.get("underlyingApy") or 0
        pendle_apy_raw   = m.get("pendleApy") or 0
        swap_fee_apy_raw = m.get("swapFeeApy") or 0
        lp_reward_raw    = m.get("lpRewardApy") or 0
        lp_total         = underlying_apy + pendle_apy_raw + swap_fee_apy_raw + lp_reward_raw

        long_yield_apy   = round((underlying_apy - implied_apy) * 100, 2)

        yt_leverage = None
        pt_disc = (m.get("ptDiscount") or 0) * 100
        if pt_disc > 0.05:
            yt_leverage = round(100 / pt_disc, 1)

        if long_yield_apy > 2:
            signal = "buy_yt"
        elif long_yield_apy < -2:
            signal = "buy_pt"
        else:
            signal = "neutral"

        results.append({
            "name":                    pt.get("symbol") or m.get("symbol") or "?",
            "address":                 m.get("address", ""),
            "pt_address":              pt.get("address", ""),
            "pt_apy":                  round(implied_apy * 100, 2),
            "underlying_apy":          round(underlying_apy * 100, 2),
            "pt_price":                round(pt_price, 4) if pt_price else None,
            "pt_discount":             round(pt_disc, 2),
            "volume_24h":              round((m.get("tradingVolume") or {}).get("usd") or 0),
            "expiry":                  expiry_str[:10],
            "days_left":               days_left,
            "liquidity_usd":           round(liq_usd),
            "gross_profit":            round(gross, 2),
            "net_profit":              round(gross - GAS_SIMPLE, 2),
            "long_yield_apy":          long_yield_apy,
            "yt_leverage":             yt_leverage,
            "signal":                  signal,
            "pendle_apy":              round(pendle_apy_raw * 100, 2),
            "swap_fee_apy":            round(swap_fee_apy_raw * 100, 2),
            "lp_reward_apy":           round(lp_reward_raw * 100, 2),
            "lp_total_apy":            round(lp_total * 100, 2),
            "underlying_interest_apy": round((m.get("underlyingInterestApy") or 0) * 100, 2),
            "underlying_reward_apy":   round((m.get("underlyingRewardApy") or 0) * 100, 2),
            "yt_floating_apy":         round((m.get("ytFloatingApy") or 0) * 100, 2),
            "category_ids":            m.get("categoryIds") or [],
            "protocol":                m.get("protocol") or "",
            "zappable":                bool(m.get("zappable")),
            "alpha":                   None,
            "risk_tier":               None,
        })
    return sorted(results, key=lambda x: x["pt_apy"], reverse=True)

# ── Morpho ────────────────────────────────────────────────────────────────────

def fetch_morpho_all():
    """Single-pass fetch of all whitelisted Morpho markets → (pt_list, lending_list)."""
    all_items = []
    skip = 0
    while True:
        query = f"""
        query {{
          markets(where: {{whitelisted: true}}, first: 200, skip: {skip}) {{
            items {{
              marketId
              lltv
              state {{
                borrowApy supplyApy utilization
                liquidityAssetsUsd supplyAssetsUsd borrowAssetsUsd
              }}
              loanAsset {{ symbol }}
              collateralAsset {{ symbol }}
            }}
          }}
        }}
        """
        resp  = post_json(MORPHO_GQL, {"query": query})
        items = (resp.get("data") or {}).get("markets", {}).get("items", [])
        all_items.extend(items)
        if len(items) < 200:
            break
        skip += 200

    pt_list      = []
    lending_list = []
    for m in all_items:
        ca      = m.get("collateralAsset") or {}
        col     = ca.get("symbol", "")
        state   = m.get("state") or {}
        liq_usd = state.get("liquidityAssetsUsd") or 0
        lltv    = int(m.get("lltv", "860000000000000000")) / 1e18
        entry   = {
            "market_id":        m.get("marketId", ""),
            "collateral":       col,
            "loan":             (m.get("loanAsset") or {}).get("symbol", "?"),
            "lltv":             round(lltv * 100, 1),
            "borrow_apy":       round((state.get("borrowApy")  or 0) * 100, 2),
            "supply_apy":       round((state.get("supplyApy")  or 0) * 100, 2),
            "utilization":      round((state.get("utilization") or 0) * 100, 1),
            "liquidity_usd":    round(liq_usd),
            "supply_total_usd": round(state.get("supplyAssetsUsd") or 0),
            "borrow_total_usd": round(state.get("borrowAssetsUsd") or 0),
        }
        if col.lower().startswith("pt-"):
            if liq_usd >= MORPHO_MIN_LIQ:
                pt_list.append(entry)
        elif col:  # skip empty-collateral metamorpho vaults
            if liq_usd >= MORPHO_LENDING_MIN_LIQ:
                lending_list.append(entry)

    lending_list.sort(key=lambda x: -x["liquidity_usd"])
    return pt_list, lending_list

# ── History tracking ──────────────────────────────────────────────────────────

def update_history(loops):
    ts = datetime.now(timezone.utc).isoformat()
    for l in loops:
        mid = l.get("market_id", "")
        if not mid:
            continue
        _history[mid].append({
            "ts":         ts,
            "borrow_apy": l.get("borrow_apy"),
            "utilization": l.get("utilization"),
        })
        if len(_history[mid]) > HISTORY_MAX:
            _history[mid].pop(0)

def get_trend(market_id):
    hist = _history.get(market_id, [])
    if len(hist) < 2:
        return {"borrow": "flat", "util": "flat"}
    prev = hist[-2]
    curr = hist[-1]
    def direction(old, new, threshold=0.3):
        if old is None or new is None:
            return "flat"
        if new - old > threshold:
            return "up"
        if old - new > threshold:
            return "down"
        return "flat"
    return {
        "borrow": direction(prev["borrow_apy"], curr["borrow_apy"]),
        "util":   direction(prev["utilization"], curr["utilization"]),
    }

# ── Strategy math ─────────────────────────────────────────────────────────────

def loop_at_hf(pt_apy, borrow_apy, lltv_pct, days, capital, gas_loop, hf):
    ltv      = (lltv_pct / 100) / hf
    leverage = 1 / (1 - ltv)
    net_apy  = (pt_apy / 100) * leverage - (borrow_apy / 100) * (leverage - 1)
    gross    = capital * net_apy * days / 365
    return {
        "hf":         hf,
        "ltv":        round(ltv * 100, 1),
        "leverage":   round(leverage, 2),
        "net_apy":    round(net_apy * 100, 2),
        "gross":      round(gross, 2),
        "net_profit": round(gross - gas_loop, 2),
    }

def build_loops(pendle, morpho_pt, gas):
    pendle_by_sym = {pm["name"].lower(): pm for pm in pendle}
    gas_loop   = (gas or {}).get("cost_loop") or GAS_LOOP
    gas_simple = (gas or {}).get("cost_simple") or GAS_SIMPLE

    loops = []
    for mm in morpho_pt:
        col_lower = mm["collateral"].lower()
        pm        = pendle_by_sym.get(col_lower)
        loop      = None
        hf_table  = []
        liq_price = None
        breakeven_borrow  = None
        breakeven_capital = None

        if pm and pm["days_left"]:
            pt_apy     = pm["pt_apy"]
            borrow_apy = mm["borrow_apy"]
            lltv_pct   = mm["lltv"]
            days       = pm["days_left"]

            # Default loop at configured HF
            loop = loop_at_hf(pt_apy, borrow_apy, lltv_pct, days, CAPITAL, gas_loop, HF)

            # HF sensitivity table
            for hf in [1.5, 1.75, 2.0, 2.5, 3.0]:
                hf_table.append(loop_at_hf(pt_apy, borrow_apy, lltv_pct, days, CAPITAL, gas_loop, hf))

            # Liquidation price: what PT price triggers liquidation
            # Liq when: collateral_value × LLTV = debt
            # collateral_value = total_pt × PT_price_at_liq
            # debt = total_pt_usd - equity
            total_pt = CAPITAL * loop["leverage"]
            debt     = total_pt - CAPITAL
            liq_price = round(debt / (total_pt * (lltv_pct / 100)), 4)

            # Break-even borrow rate: borrow APY where net_apy = 0
            leverage = loop["leverage"]
            if leverage > 1:
                breakeven_borrow = round(pt_apy * leverage / (leverage - 1), 2)

            # Break-even capital: min capital where loop net > simple PT net
            extra_apy_frac = max(0, (loop["net_apy"] - pt_apy) / 100)
            if extra_apy_frac > 0:
                extra_gas = gas_loop - gas_simple
                breakeven_capital = round(extra_gas / (extra_apy_frac * days / 365))
            else:
                breakeven_capital = None

        simple_pt_profit = None
        if pm and pm.get("days_left"):
            simple_pt_profit = round(CAPITAL * (pm["pt_apy"] / 100) * pm["days_left"] / 365, 2)

        loop_extra = None
        if loop is not None and simple_pt_profit is not None:
            loop_extra = round(loop["net_profit"] - simple_pt_profit, 2)

        loops.append({
            **mm,
            "pendle_pt_apy":      pm["pt_apy"] if pm else None,
            "pendle_underlying":  pm["underlying_apy"] if pm else None,
            "pendle_alpha":       pm.get("alpha") if pm else None,
            "risk_tier":          pm.get("risk_tier") or 3 if pm else 3,
            "days_left":          pm["days_left"] if pm else None,
            "pendle_liq":         pm["liquidity_usd"] if pm else None,
            "loop":               loop,
            "hf_table":           hf_table,
            "liquidation_price":  liq_price,
            "breakeven_borrow":   breakeven_borrow,
            "breakeven_capital":  breakeven_capital,
            "simple_pt_profit":   simple_pt_profit,
            "loop_extra":         loop_extra,
            "trend":              get_trend(mm["market_id"]),
        })

    def sort_key(o):
        if o["loop"] and o["loop"]["net_profit"] > 0:
            return (0, -o["loop"]["net_apy"])
        if o["loop"]:
            return (1, -o["loop"]["net_apy"])
        return (2, -o["liquidity_usd"])

    return sorted(loops, key=sort_key)

# ── LP Opportunities ──────────────────────────────────────────────────────────

def build_lp_opps(pendle):
    return sorted(
        [p for p in pendle if p.get("lp_total_apy", 0) > 0],
        key=lambda x: -x["lp_total_apy"]
    )

# ── Enrich Pendle with alpha + risk_tier ──────────────────────────────────────

TIER1 = {"SUSDE","STETH","WSTETH","WEETH","USDE","SUSDS","USDG","SUSDZ","SNUSD","RSUSD"}
TIER2 = {"RSETH","EZETH","CBETH","RETH","PUFETH","EETH","APXUSD","APYUSD"}

def enrich_pendle(pendle, aave):
    usd_syms = {"USDC","USDT","DAI"}
    eth_syms = {"WETH","WSTETH","WEETH"}
    usd_best = max((a["supply_apy"] for a in aave if a["symbol"] in usd_syms), default=0)
    eth_best = max((a["supply_apy"] for a in aave if a["symbol"] in eth_syms), default=0)
    for p in pendle:
        upper   = (p["name"] or "").upper()
        is_eth  = ("ETH" in upper or "BTC" in upper) and "USD" not in upper
        best_alt = eth_best if is_eth else usd_best
        base     = upper.replace("PT-", "").split("-")[0]
        if any(t in base for t in TIER1):
            p["risk_tier"] = 1
        elif any(t in base for t in TIER2):
            p["risk_tier"] = 2
        else:
            p["risk_tier"] = 3
        p["alpha"]        = round(p["pt_apy"] - best_alt, 2)
        p["best_alt_apy"] = round(best_alt, 2)
    return pendle

# ── Fetch all ─────────────────────────────────────────────────────────────────

def fetch_aave_rates():
    """Aave v3 Ethereum supply/borrow rates — joins /pools (metadata) with /lendBorrow (borrow APY)."""
    TARGET = {"USDC", "USDT", "WETH", "SUSDE", "WEETH", "WSTETH", "DAI"}

    pools_resp = get_json("https://yields.llama.fi/pools")
    pools = {p["pool"]: p for p in pools_resp.get("data", [])}

    lb_resp = get_json("https://yields.llama.fi/lendBorrow")
    lb_rows = lb_resp if isinstance(lb_resp, list) else lb_resp.get("data", [])
    lb = {p["pool"]: p for p in lb_rows}

    results = {}
    for pool_id, p in pools.items():
        if p.get("project") != "aave-v3" or p.get("chain") != "Ethereum":
            continue
        sym = p.get("symbol", "").upper()
        if sym not in TARGET:
            continue
        tvl = p.get("tvlUsd") or 0
        l   = lb.get(pool_id, {})
        if sym not in results or tvl > (results[sym].get("total_supply_usd") or 0):
            results[sym] = {
                "symbol":           sym,
                "supply_apy":       round(p.get("apyBase") or 0, 2),
                "borrow_apy":       round(l.get("apyBaseBorrow") or 0, 2),
                "ltv":              round((l.get("ltv") or 0) * 100, 1),
                "total_supply_usd": round(tvl),
                "total_borrow_usd": round(l.get("totalBorrowUsd") or 0),
            }
    order = ["USDC", "USDT", "WETH", "WSTETH", "WEETH", "SUSDE", "DAI"]
    return sorted(results.values(), key=lambda x: order.index(x["symbol"]) if x["symbol"] in order else 99)


def fetch_ethena_yield():
    """sUSDe staking yield from Ethena API."""
    d = get_json("https://app.ethena.fi/api/yields/protocol-and-staking-yield")
    return {
        "staking_apy":  round((d.get("stakingYield")     or {}).get("value") or 0, 2),
        "avg30d_apy":   round((d.get("avg30dSusdeYield")  or {}).get("value") or 0, 2),
        "protocol_apy": round((d.get("protocolYield")     or {}).get("value") or 0, 2),
    }


def safe(fn, fallback, label=""):
    """Run fn(), return fallback on any exception."""
    try:
        return fn()
    except Exception as e:
        print(f"[WARN] {label or fn.__name__}: {e}")
        return fallback

def fetch_all():
    # Core fetches — must succeed
    pendle               = fetch_pendle()
    morpho_pt, morpho_lending = fetch_morpho_all()

    # Optional fetches — failures return empty defaults
    gas    = safe(fetch_gas,          {}, "gas")
    peg    = safe(fetch_peg,          {"price": None, "status": "unknown"}, "peg")
    aave   = safe(fetch_aave_rates,   [], "aave")
    ethena = safe(fetch_ethena_yield, {}, "ethena")

    pendle  = enrich_pendle(pendle, aave)
    lp_opps = build_lp_opps(pendle)
    update_history(morpho_pt)
    loops = build_loops(pendle, morpho_pt, gas)

    return {
        "pendle":          pendle,
        "loops":           loops,
        "lp_opps":         lp_opps,
        "morpho_lending":  morpho_lending,
        "aave":            aave,
        "ethena":          ethena,
        "gas":             gas,
        "peg":             peg,
        "capital":         CAPITAL,
        "hf":              HF,
        "gas_simple":      gas.get("cost_simple") or GAS_SIMPLE,
        "gas_loop":        gas.get("cost_loop")   or GAS_LOOP,
        "updated_at":      datetime.now(timezone.utc).isoformat(),
    }

# ── Background refresh ────────────────────────────────────────────────────────

def refresh_loop():
    while True:
        try:
            data = fetch_all()
            with _lock:
                _state["data"]       = data
                _state["updated_at"] = data["updated_at"]
                _state["error"]      = None          # clear any previous error
            matched = sum(1 for l in data["loops"] if l["loop"])
            peg     = data["peg"].get("price", "?")
            gwei    = data["gas"].get("gwei", "?")
            susde   = data.get("ethena", {}).get("staking_apy", "?")
            aave_u  = next((a["borrow_apy"] for a in (data.get("aave") or []) if a["symbol"] == "USDC"), "?")
            print(f"[{data['updated_at'][:19]}] "
                  f"{len(data['pendle'])} Pendle · "
                  f"{matched} loops · "
                  f"{len(data.get('morpho_lending', []))} lending · "
                  f"sUSDe={susde}% · AaveUSDC={aave_u}% · "
                  f"apxUSD=${peg} · {gwei} gwei")
        except Exception as e:
            with _lock:
                # Keep old data — only surface error if we have nothing
                if _state["data"] is None:
                    _state["error"] = str(e)
            print(f"[WARN] refresh failed (old data still served): {e}")
        time.sleep(REFRESH_SEC)

# ── HTTP server ───────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        if self.path == "/api/data":
            with _lock:
                body = json.dumps({
                    "data":       _state["data"],
                    "updated_at": _state["updated_at"],
                    "error":      _state["error"],
                }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        elif self.path in ("/", "/index.html"):
            import os
            html = open(os.path.join(os.path.dirname(__file__), "index.html"), "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(html)

        elif self.path == "/favicon.svg":
            import os
            public = os.path.join(os.path.dirname(os.path.dirname(__file__)), "public", "favicon.svg")
            try:
                data = open(public, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "image/svg+xml")
                self.end_headers()
                self.wfile.write(data)
            except Exception:
                self.send_response(404); self.end_headers()

        elif self.path == "/apple-touch-icon.png":
            import os
            public = os.path.join(os.path.dirname(os.path.dirname(__file__)), "public", "apple-touch-icon.png")
            try:
                data = open(public, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.end_headers()
                self.wfile.write(data)
            except Exception:
                self.send_response(404); self.end_headers()

        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    import socketserver
    socketserver.TCPServer.allow_reuse_address = True

    print("Starting yield tracker — fetching initial data...")
    try:
        data = fetch_all()
        with _lock:
            _state["data"]       = data
            _state["updated_at"] = data["updated_at"]
            _state["error"]      = None
        matched = sum(1 for l in data["loops"] if l["loop"])
        print(f"Ready: {len(data['pendle'])} Pendle · "
              f"{len(data['loops'])} Morpho PT · "
              f"{matched} matched · "
              f"apxUSD=${data['peg'].get('price')} · "
              f"{data['gas'].get('gwei')} gwei")
    except Exception as e:
        print(f"Initial fetch error: {e}")
        with _lock:
            _state["error"] = str(e)

    threading.Thread(target=refresh_loop, daemon=True).start()
    print("Dashboard → http://localhost:8765")
    HTTPServer(("0.0.0.0", 8765), Handler).serve_forever()
