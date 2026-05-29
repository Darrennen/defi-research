#!/usr/bin/env python3
"""
Polymarket World Cup Bot
────────────────────────
Scans WC markets, detects edge vs ELO model, auto-trades with full safety rails.

Usage:
  python3 bot.py              # dry run (default, no real trades)
  python3 bot.py --live       # real trading (only after dry-run passes)
  python3 bot.py --stop       # emergency: cancel all open orders and exit
  python3 bot.py --scan       # print edge table only, no trading

Requirements:
  pip install py-clob-client-v2 python-dotenv requests
"""

import argparse
import json
import logging
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ── Optional trading SDK ──────────────────────────────────────────────────────
try:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import MarketOrderArgs, OrderType, OpenOrderParams
    from py_clob_client.order_builder.constants import BUY, SELL
    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass  # .env loaded manually below if needed


# ── Config ────────────────────────────────────────────────────────────────────

DRY_RUN             = True    # flipped to False by --live flag only
MAX_SINGLE_BET      = 30.0    # max $ per single position
MAX_DAILY_SPEND     = 80.0    # hard stop if daily spend hits this
MAX_OPEN_POSITIONS  = 6       # max simultaneous open positions
MIN_EDGE            = 0.07    # minimum edge to trigger a trade (7%)
MIN_WALLET_BALANCE  = 10.0    # stop trading if USDC drops below this
STOP_LOSS_PCT       = 0.40    # exit if position price drops 40% from entry
KELLY_FRACTION      = 0.25    # fractional Kelly (1/4 Kelly)
SCAN_INTERVAL_SEC   = 60      # seconds between edge scans
PRICE_CHECK_SEC     = 15      # seconds between stop-loss price checks

CLOB_API   = "https://clob.polymarket.com"
GAMMA_API  = "https://gamma-api.polymarket.com"
CHAIN_ID   = 137              # Polygon mainnet

LOG_FILE   = Path(__file__).parent / "trades.log"
STATE_FILE = Path(__file__).parent / "state.json"


# ── FIFA ELO Ratings (May 2026) ───────────────────────────────────────────────
# Based on FIFA ranking points converted to ELO scale.
# Home nations get +65 bonus applied at match time.

ELO: dict[str, int] = {
    "france":             1855,
    "spain":              1845,
    "england":            1805,
    "portugal":           1785,
    "brazil":             1775,
    "argentina":          1765,
    "germany":            1735,
    "netherlands":        1725,
    "belgium":            1705,
    "norway":             1675,
    "japan":              1665,
    "colombia":           1655,
    "morocco":            1645,
    "uruguay":            1635,
    "croatia":            1625,
    "switzerland":        1605,
    "austria":            1595,
    "sweden":             1585,
    "turkiye":            1575,
    "turkey":             1575,
    "usa":                1565,
    "united states":      1565,
    "mexico":             1555,
    "canada":             1535,
    "senegal":            1525,
    "ghana":              1515,
    "iran":               1505,
    "ir iran":            1505,
    "australia":          1495,
    "korea republic":     1485,
    "south korea":        1485,
    "ecuador":            1475,
    "czechia":            1470,
    "scotland":           1435,
    "egypt":              1425,
    "saudi arabia":       1430,
    "ivory coast":        1425,
    "côte d'ivoire":      1425,
    "cote d ivoire":      1425,
    "ivory coast":        1425,
    "bosnia-herzegovina": 1420,
    "paraguay":           1375,
    "algeria":            1405,
    "south africa":       1405,
    "panama":             1365,
    "iraq":               1365,
    "qatar":              1345,
    "new zealand":        1315,
    "jordan":             1325,
    "cape verde":         1360,
    "cabo verde":         1360,
    "haiti":              1295,
    "dr congo":           1385,
    "congo dr":           1385,
    "uzbekistan":         1395,
    "curaçao":            1295,
    "curacao":            1295,
    "tunisia":            1415,
}

HOME_NATIONS = {"usa", "united states", "mexico", "canada"}
HOME_ADVANTAGE_ELO = 65


# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_FILE),
    ],
)
log = logging.getLogger("polybot")


def log_trade(action: str, market: str, amount: float, price: float,
              edge: float = 0, extra: str = ""):
    line = (f"{action:<8} | {market:<30} | ${amount:>6.2f} "
            f"| price={price:.2f}¢ | edge={edge:+.1%} {extra}")
    log.info(line)


# ── Telegram Alerts ───────────────────────────────────────────────────────────

def send_alert(msg: str):
    token   = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        return
    try:
        payload = json.dumps({"chat_id": chat_id, "text": msg}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        log.warning(f"Telegram alert failed: {e}")


# ── State (daily spend tracking) ──────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"daily_spend": 0.0, "date": "", "positions": {}}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def get_daily_spend(state: dict) -> float:
    if state.get("date") != today():
        state["daily_spend"] = 0.0
        state["date"] = today()
    return state["daily_spend"]


def record_spend(state: dict, amount: float):
    if state.get("date") != today():
        state["daily_spend"] = 0.0
        state["date"] = today()
    state["daily_spend"] = state.get("daily_spend", 0.0) + amount
    save_state(state)


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def get_json(url: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json",
                                               "User-Agent": "polybot/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# ── ELO Probability Model ─────────────────────────────────────────────────────

def elo_lookup(name: str) -> int | None:
    return ELO.get(name.lower().strip())


def win_prob(elo_a: int, elo_b: int, home_a: bool = False) -> tuple[float, float, float]:
    """
    Returns (p_win_a, p_draw, p_loss_a) using ELO + draw model.
    home_a: True if team A is playing on home soil (USA/Mexico/Canada).
    """
    adj_a = elo_a + (HOME_ADVANTAGE_ELO if home_a else 0)
    expected = 1 / (1 + 10 ** ((elo_b - adj_a) / 400))

    # Draw probability: peaks ~26% for evenly matched, falls as gap widens
    competitiveness = 1 - abs(expected - 0.5) * 2
    p_draw  = max(0.05, 0.28 * competitiveness)
    p_win_a = max(0.02, expected   - p_draw / 2)
    p_loss  = max(0.02, 1 - p_win_a - p_draw)

    # Normalise
    total   = p_win_a + p_draw + p_loss
    return p_win_a / total, p_draw / total, p_loss / total


def kelly_stake(p_model: float, price: float, bankroll: float) -> float:
    """
    Fractional Kelly stake in USD.
    price: Polymarket price in cents (0-100).
    """
    q = price / 100          # cost per share
    b = (1 - q) / q          # net odds (profit per dollar risked)
    full_kelly = (p_model * b - (1 - p_model)) / b
    stake = max(0.0, full_kelly * KELLY_FRACTION * bankroll)
    return min(stake, MAX_SINGLE_BET)


# ── Market Scanner ────────────────────────────────────────────────────────────

def fetch_wc_game_markets() -> list[dict]:
    """
    Fetch active WC match markets from Gamma API.
    Returns list of dicts with: question, token_id, outcome, price, market_slug
    """
    url  = f"{GAMMA_API}/markets?active=true&tag_slug=2026-fifa-world-cup&limit=200"
    data = get_json(url)
    markets = data if isinstance(data, list) else data.get("data", [])

    results = []
    for m in markets:
        question = m.get("question", "")
        tokens   = m.get("tokens") or []
        slug     = m.get("groupSlug") or m.get("slug", "")

        for tok in tokens:
            outcome  = tok.get("outcome", "")
            token_id = tok.get("token_id") or tok.get("tokenId", "")
            price    = float(tok.get("price") or 0) * 100  # convert to cents

            results.append({
                "question":  question,
                "outcome":   outcome,
                "token_id":  token_id,
                "price":     price,
                "slug":      slug,
            })
    return results


def parse_teams(question: str) -> tuple[str, str] | None:
    """
    Extract team A and team B from a market question.
    Handles formats like 'Will X win?', 'X vs Y', 'X to beat Y'
    """
    q = question.lower()
    for sep in [" vs ", " vs. ", " v ", " beat ", " defeat "]:
        if sep in q:
            parts = q.split(sep, 1)
            a = parts[0].strip().lstrip("will ").strip()
            b = parts[1].strip().rstrip("?").split("?")[0].strip()
            return a, b
    return None


def get_live_price(token_id: str) -> float | None:
    """Get current mid price for a token from CLOB API (no auth needed)."""
    try:
        data  = get_json(f"{CLOB_API}/midpoint?token_id={token_id}")
        mid   = data.get("mid") or data.get("price")
        return float(mid) * 100 if mid else None
    except Exception:
        return None


def scan_edges(bankroll: float) -> list[dict]:
    """
    Scan all WC markets. Return list of opportunities sorted by edge descending.
    """
    log.info("Scanning WC markets for edge...")
    try:
        markets = fetch_wc_game_markets()
    except Exception as e:
        log.warning(f"Market fetch failed: {e}")
        return []

    opps = []
    seen_markets = set()

    for m in markets:
        teams = parse_teams(m["question"])
        if not teams:
            continue

        team_a, team_b = teams
        outcome = m["outcome"].lower()

        # Only process WIN outcomes (not draw)
        if "draw" in outcome or "tie" in outcome:
            continue

        # Figure out which team this outcome is for
        if team_a in outcome or outcome in team_a:
            bettor_team, opp_team = team_a, team_b
        elif team_b in outcome or outcome in team_b:
            bettor_team, opp_team = team_b, team_a
        else:
            continue

        elo_a = elo_lookup(bettor_team)
        elo_b = elo_lookup(opp_team)
        if not elo_a or not elo_b:
            continue

        home_a = bettor_team in HOME_NATIONS
        p_win, _, _ = win_prob(elo_a, elo_b, home_a)

        price = m["price"]
        if price <= 0:
            price = get_live_price(m["token_id"]) or 0
        if price <= 0 or price >= 99:
            continue

        p_market = price / 100
        edge     = p_win - p_market
        stake    = kelly_stake(p_win, price, bankroll)

        market_key = f"{m['question']}|{bettor_team}"
        if market_key in seen_markets:
            continue
        seen_markets.add(market_key)

        opps.append({
            "question":    m["question"],
            "outcome":     m["outcome"],
            "token_id":    m["token_id"],
            "slug":        m["slug"],
            "team":        bettor_team.title(),
            "opp":         opp_team.title(),
            "elo_team":    elo_a,
            "elo_opp":     elo_b,
            "p_model":     p_win,
            "p_market":    p_market,
            "edge":        edge,
            "price":       price,
            "stake":       stake,
        })

    opps.sort(key=lambda x: -x["edge"])
    return opps


def print_edge_table(opps: list[dict]):
    print("\n" + "─" * 90)
    print(f"{'TEAM':<22} {'VS':<22} {'MODEL%':>7} {'MARKET%':>8} {'EDGE':>7} {'STAKE':>7} {'ELO A':>6} {'ELO B':>6}")
    print("─" * 90)
    for o in opps:
        flag = " ◀ TRADE" if o["edge"] >= MIN_EDGE else ""
        print(
            f"{o['team']:<22} {o['opp']:<22} "
            f"{o['p_model']:>6.1%} {o['p_market']:>7.1%} "
            f"{o['edge']:>+6.1%} ${o['stake']:>5.2f}"
            f"  {o['elo_team']:>5}  {o['elo_opp']:>5}{flag}"
        )
    print("─" * 90 + "\n")


# ── Safety Checks ─────────────────────────────────────────────────────────────

def safety_checks(opp: dict, state: dict, client=None) -> str | None:
    """
    Return an error string if a trade should be blocked, None if safe to proceed.
    """
    # Daily spend limit
    if get_daily_spend(state) + opp["stake"] > MAX_DAILY_SPEND:
        return f"daily spend limit (${MAX_DAILY_SPEND}) would be exceeded"

    # Max open positions
    if len(state.get("positions", {})) >= MAX_OPEN_POSITIONS:
        return f"max open positions ({MAX_OPEN_POSITIONS}) reached"

    # Minimum edge
    if opp["edge"] < MIN_EDGE:
        return f"edge {opp['edge']:.1%} below minimum {MIN_EDGE:.1%}"

    # Wallet balance (requires auth client)
    if client:
        try:
            bal = float(client.get_usdc_balance() or 0)
            if bal < MIN_WALLET_BALANCE + opp["stake"]:
                return f"wallet balance ${bal:.2f} too low"
        except Exception:
            pass

    # Already have a position in this market
    if opp["token_id"] in state.get("positions", {}):
        return "already have an open position in this market"

    return None


# ── Trading ───────────────────────────────────────────────────────────────────

def init_client():
    """Initialise the CLOB trading client from environment variables."""
    if not SDK_AVAILABLE:
        log.error("py-clob-client-v2 not installed. Run: pip install py-clob-client-v2")
        sys.exit(1)

    key    = os.getenv("PRIVATE_KEY")
    funder = os.getenv("WALLET_ADDRESS")
    if not key or not funder:
        log.error("PRIVATE_KEY and WALLET_ADDRESS must be set in .env")
        sys.exit(1)

    client = ClobClient(
        CLOB_API,
        key=key,
        chain_id=CHAIN_ID,
        signature_type=1,
        funder=funder,
    )
    client.set_api_creds(client.create_or_derive_api_creds())
    log.info(f"Trading client initialised — funder: {funder[:8]}...")
    return client


def place_bet(client, opp: dict, state: dict) -> bool:
    """Place a market order. Returns True on success."""
    token_id = opp["token_id"]
    amount   = opp["stake"]
    label    = f"{opp['team']} WIN vs {opp['opp']}"

    if DRY_RUN:
        log_trade("DRY-RUN", label, amount, opp["price"], opp["edge"])
        send_alert(f"🧪 DRY RUN | {label}\n${amount:.2f} @ {opp['price']:.1f}¢ | edge {opp['edge']:+.1%}")
        return True

    try:
        order  = MarketOrderArgs(
            token_id=token_id,
            amount=amount,
            side=BUY,
            order_type=OrderType.FOK,
        )
        signed = client.create_market_order(order)
        resp   = client.post_order(signed, OrderType.FOK)

        if resp.get("success"):
            entry_price = opp["price"]
            state.setdefault("positions", {})[token_id] = {
                "label":       label,
                "entry_price": entry_price,
                "amount":      amount,
                "opened_at":   datetime.now(timezone.utc).isoformat(),
            }
            record_spend(state, amount)
            log_trade("BET", label, amount, entry_price, opp["edge"])
            send_alert(f"✅ BET PLACED | {label}\n${amount:.2f} @ {entry_price:.1f}¢ | edge {opp['edge']:+.1%}")
            return True
        else:
            log.warning(f"Order rejected: {resp}")
            return False

    except Exception as e:
        log.error(f"Order failed for {label}: {e}")
        return False


def exit_position(client, token_id: str, pos: dict, reason: str):
    """Sell / exit an open position."""
    label = pos.get("label", token_id[:12])

    if DRY_RUN:
        log_trade("DRY-EXIT", label, pos.get("amount", 0), 0, extra=f"({reason})")
        return

    try:
        open_orders = client.get_orders(OpenOrderParams())
        for o in open_orders:
            if o.get("asset_id") == token_id:
                client.cancel(o["id"])

        # Sell entire position at market
        bal = client.get_token_balance(token_id)
        if bal and float(bal) > 0:
            order  = MarketOrderArgs(
                token_id=token_id,
                amount=float(bal),
                side=SELL,
                order_type=OrderType.FOK,
            )
            signed = client.create_market_order(order)
            client.post_order(signed, OrderType.FOK)

        log_trade("EXIT", label, pos.get("amount", 0), 0, extra=f"({reason})")
        send_alert(f"🚪 EXIT | {label} | {reason}")

    except Exception as e:
        log.error(f"Exit failed for {label}: {e}")


# ── Emergency Stop ────────────────────────────────────────────────────────────

def emergency_stop(client, reason: str):
    log.critical(f"EMERGENCY STOP: {reason}")
    send_alert(f"🛑 EMERGENCY STOP\n{reason}")
    try:
        client.cancel_all()
        log.info("All orders cancelled.")
    except Exception as e:
        log.error(f"cancel_all failed: {e}")
    sys.exit(1)


# ── Stop-Loss Monitor ─────────────────────────────────────────────────────────

def check_stop_losses(client, state: dict):
    """Check all open positions and exit if stop-loss threshold is hit."""
    positions = state.get("positions", {})
    to_close  = []

    for token_id, pos in positions.items():
        current = get_live_price(token_id)
        if current is None:
            continue

        entry  = pos.get("entry_price", 50)
        drop   = (entry - current) / entry if entry > 0 else 0

        if drop >= STOP_LOSS_PCT:
            log.warning(f"STOP LOSS | {pos.get('label')} | entry={entry:.1f}¢ current={current:.1f}¢ drop={drop:.1%}")
            to_close.append((token_id, pos, f"stop-loss {drop:.1%} drop"))

    for token_id, pos, reason in to_close:
        exit_position(client, token_id, pos, reason)
        state["positions"].pop(token_id, None)

    if to_close:
        save_state(state)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global DRY_RUN

    parser = argparse.ArgumentParser()
    parser.add_argument("--live",  action="store_true", help="Disable dry-run, trade real money")
    parser.add_argument("--stop",  action="store_true", help="Emergency stop: cancel all orders")
    parser.add_argument("--scan",  action="store_true", help="Print edge table only, no trading")
    args = parser.parse_args()

    if args.live:
        DRY_RUN = False
        log.warning("⚠️  LIVE MODE — real money will be traded")

    state    = load_state()
    bankroll = float(os.getenv("BANKROLL", "140"))

    # ── Emergency stop mode ──
    if args.stop:
        client = init_client()
        emergency_stop(client, "Manual --stop flag")

    # ── Scan-only mode ──
    if args.scan:
        opps = scan_edges(bankroll)
        print_edge_table(opps)
        above = [o for o in opps if o["edge"] >= MIN_EDGE]
        print(f"Found {len(above)} markets with edge ≥ {MIN_EDGE:.0%}\n")
        return

    # ── Full bot mode ──
    client = init_client() if not DRY_RUN else None

    # If dry run, still need a mock client placeholder for safety checks
    if DRY_RUN:
        log.info("DRY RUN mode — no real orders will be placed")

    send_alert("🤖 Polymarket WC Bot started" + (" (DRY RUN)" if DRY_RUN else " (LIVE)"))

    iteration = 0
    while True:
        iteration += 1
        log.info(f"── Scan #{iteration} | daily_spend=${get_daily_spend(state):.2f} "
                 f"| positions={len(state.get('positions', {}))} ──")

        # 1. Safety: daily spend ceiling
        if get_daily_spend(state) >= MAX_DAILY_SPEND:
            log.info("Daily spend limit reached — pausing until midnight UTC")
            time.sleep(3600)
            continue

        # 2. Scan for edges
        opps = scan_edges(bankroll)
        print_edge_table(opps)

        # 3. Execute trades where edge > threshold
        for opp in opps:
            if opp["edge"] < MIN_EDGE or opp["stake"] < 1.0:
                continue

            block_reason = safety_checks(opp, state, client)
            if block_reason:
                log.info(f"SKIP {opp['team']}: {block_reason}")
                continue

            success = place_bet(client, opp, state)
            if not success:
                log.warning(f"Trade failed for {opp['team']}")

            time.sleep(2)  # brief pause between orders

        # 4. Monitor stop-losses
        if client and state.get("positions"):
            check_stop_losses(client, state)

        # 5. Wait before next scan
        log.info(f"Next scan in {SCAN_INTERVAL_SEC}s")
        time.sleep(SCAN_INTERVAL_SEC)


if __name__ == "__main__":
    main()
