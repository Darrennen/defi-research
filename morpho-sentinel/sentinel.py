#!/usr/bin/env python3
"""
Morpho sentinel — self-arming watcher for leveraged positions.

Silent while the book is empty. The day a position appears (a new PT loop,
any collateral/borrow, a vault deposit) it ARMS and alerts; from then on it
alerts on health-factor / liquidation-distance / borrow-rate breaches, and
on the position closing. Weekly heartbeat proves it's alive.

Stdlib only. State in .sentinel_state.json next to this file.
Alerts via Telegram (env TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID >
~/citrindex-scraper/telegram.json > ~/telegram-config.json); with no creds
it prints what it WOULD send (safe to run anywhere).

Usage:
  python3 sentinel.py            # one check (cron/launchd/cloud-routine mode)
  python3 sentinel.py --loop 900 # resilient daemon, check every 900s
  python3 sentinel.py --test     # show current book + send a test alert

Exit codes: 0 = checked fine (alerts sent if due) · 1 = data/API failure.
"""
import argparse, json, sys, time, urllib.request
from pathlib import Path

WALLETS = ["0x59246526d823243d3223B21417d57830d66602B5"]
CHAINS = [1, 8453, 42161, 999]          # ethereum, base, arbitrum, hyperevm
API = "https://blue-api.morpho.org/graphql"

HF_WARN, HF_DANGER = 1.6, 1.2
BORROW_APY_WARN = 0.10                  # carry likely inverted for a PT loop
LIQ_DISTANCE_WARN = 0.10                # within 10% price move of liquidation
ALERT_COOLDOWN_S = 6 * 3600
HEARTBEAT_S = 7 * 86400

HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / ".sentinel_state.json"

# 2026-07 schema: balances live under state{}; top-level collateralUsd etc. are gone
QUERY = """query($a: String!, $c: Int!) { userByAddress(address: $a, chainId: $c) {
  marketPositions { healthFactor priceVariationToLiquidationPrice
    state { collateralUsd borrowAssetsUsd marginUsd }
    market { marketId lltv collateralAsset { symbol } loanAsset { symbol }
             state { borrowApy } } }
  vaultPositions { state { assetsUsd } vault { name } } } }"""


def gql(wallet, chain):
    body = json.dumps({"query": QUERY, "variables": {"a": wallet, "c": chain}}).encode()
    req = urllib.request.Request(API, data=body, headers={"content-type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    if d.get("errors"):
        raise RuntimeError("graphql: " + (d["errors"][0].get("message") or "?")[:200])
    return (d.get("data") or {}).get("userByAddress") or {}


def _tg_creds():
    import os
    k, c = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if k and c:
        return k, c
    for p in (Path.home() / "citrindex-scraper/telegram.json", Path.home() / "telegram-config.json"):
        try:
            j = json.loads(p.read_text())
            if j.get("bot_token") and j.get("chat_id"):
                return j["bot_token"], j["chat_id"]
        except Exception:
            pass
    return None, None


def alert(msg):
    tok, chat = _tg_creds()
    print(("SEND: " if tok else "WOULD SEND (no telegram creds): ") + msg.replace("\n", " | "))
    if not tok:
        return
    body = json.dumps({"chat_id": chat, "text": "🛰 Morpho sentinel\n" + msg}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage",
                                 data=body, headers={"content-type": "application/json"})
    for i in range(3):
        try:
            urllib.request.urlopen(req, timeout=15)
            return
        except Exception:
            time.sleep(10)
    print("telegram send failed 3x", file=sys.stderr)


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"positions": {}, "alerted": {}, "last_heartbeat": 0, "api_broken": False}


def sweep():
    """One pass over all wallets × chains. Returns (live_positions, vaults)."""
    live, vaults = [], []
    for w in WALLETS:
        for c in CHAINS:
            u = gql(w, c)
            for m in u.get("marketPositions") or []:
                s = m.get("state") or {}
                if (s.get("collateralUsd") or 0) > 1 or (s.get("borrowAssetsUsd") or 0) > 1:
                    mk = m["market"]
                    live.append({
                        "key": f"{c}:{mk['marketId'][:10]}",
                        "pair": f"{mk['collateralAsset']['symbol']}/{mk['loanAsset']['symbol']}",
                        "coll": s.get("collateralUsd") or 0, "borrow": s.get("borrowAssetsUsd") or 0,
                        "margin": s.get("marginUsd") or 0, "hf": m.get("healthFactor"),
                        "liq_dist": m.get("priceVariationToLiquidationPrice"),
                        "borrow_apy": (mk.get("state") or {}).get("borrowApy"),
                    })
            for v in u.get("vaultPositions") or []:
                if ((v.get("state") or {}).get("assetsUsd") or 0) > 1:
                    vaults.append({"key": f"{c}:{v['vault']['name']}",
                                   "usd": v["state"]["assetsUsd"]})
    return live, vaults


def fmt_pos(p):
    hf = f"{p['hf']:.2f}" if p["hf"] else "—"
    ld = f" · {abs(p['liq_dist'])*100:.0f}% to liq" if p["liq_dist"] is not None else ""
    return (f"{p['pair']}: coll ${p['coll']:,.0f} / borrow ${p['borrow']:,.0f} "
            f"(margin ${p['margin']:,.0f}) · HF {hf}{ld} · borrow APY {p['borrow_apy']*100:.1f}%")


def check():
    st = load_state()
    now = time.time()
    try:
        live, vaults = sweep()
    except Exception as ex:
        if not st.get("api_broken"):          # self-report once, not every run
            alert(f"⚠️ sentinel BROKEN — API/schema error, positions unwatched:\n{ex}")
            st["api_broken"] = True
            STATE_FILE.write_text(json.dumps(st))
        print("DATA ERROR:", ex, file=sys.stderr)
        return 1
    if st.get("api_broken"):
        alert("✅ sentinel recovered — API readable again")
        st["api_broken"] = False

    msgs, seen = [], {}
    for p in live:
        seen[p["key"]] = round(p["margin"])
        if p["key"] not in st["positions"]:
            msgs.append("🟢 ARMED — new position:\n" + fmt_pos(p))
        breaches = []
        if p["hf"] is not None and p["hf"] < HF_DANGER:
            breaches.append(f"🔴 HF {p['hf']:.2f} < {HF_DANGER} — liquidation risk NOW")
        elif p["hf"] is not None and p["hf"] < HF_WARN:
            breaches.append(f"🟠 HF {p['hf']:.2f} < {HF_WARN}")
        if p["liq_dist"] is not None and abs(p["liq_dist"]) < LIQ_DISTANCE_WARN:
            breaches.append(f"🔴 price {abs(p['liq_dist'])*100:.0f}% from liquidation")
        if (p["borrow_apy"] or 0) > BORROW_APY_WARN:
            breaches.append(f"🟠 borrow APY {p['borrow_apy']*100:.1f}% — check the loop still carries")
        for b in breaches:                     # cooldown per position+breach type
            ck = p["key"] + b[:6]
            if now - st["alerted"].get(ck, 0) > ALERT_COOLDOWN_S:
                msgs.append(b + "\n" + fmt_pos(p))
                st["alerted"][ck] = now
    for k in st["positions"]:
        if k not in seen and not k.startswith("v:"):
            msgs.append(f"⚪ position {k} closed/unwound (was margin ${st['positions'][k]:,})")
    for v in vaults:
        seen["v:" + v["key"]] = round(v["usd"])
        if "v:" + v["key"] not in st["positions"]:
            msgs.append(f"🟢 vault deposit: {v['key']} ${v['usd']:,.0f}")

    if now - st.get("last_heartbeat", 0) > HEARTBEAT_S:
        body = "\n".join(fmt_pos(p) for p in live) or "book empty — watching"
        msgs.append("💓 weekly heartbeat:\n" + body)
        st["last_heartbeat"] = now

    for m in msgs:
        alert(m)
    if not msgs:
        print(f"quiet: {len(live)} live position(s), {len(vaults)} vault(s)")
    st["positions"] = seen
    STATE_FILE.write_text(json.dumps(st))
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", type=int, default=0, metavar="SECS")
    ap.add_argument("--test", action="store_true")
    a = ap.parse_args()
    if a.test:
        live, vaults = sweep()
        print(json.dumps({"live": live, "vaults": vaults}, indent=1))
        alert("test — sentinel wiring OK. " +
              (f"{len(live)} live position(s)." if live else "Book currently empty."))
        sys.exit(0)
    if a.loop:
        while True:                            # never exit under a supervisor (the mini lesson)
            try:
                check()
            except Exception as ex:
                print("poll error:", ex, file=sys.stderr)
            time.sleep(a.loop)
    sys.exit(check())
