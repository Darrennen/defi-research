#!/usr/bin/env python3
"""PUMP insider-cohort daily inflow/outflow monitor.

Stateless: every figure is recomputed from chain each run, nothing is carried between runs.

Two hard-won rules are baked in and must not be relaxed:
  1. Query each wallet's PUMP TOKEN ACCOUNT, not the owner address. An inbound SPL transfer
     references the source ATA, destination ATA and authority -- the destination *owner* is
     never an account key, so getSignaturesForAddress on the owner silently misses every
     inbound transfer.
  2. Never use solana-rpc.publicnode.com. It returns truncated getSignaturesForAddress
     results with no error (41 signatures where the true count was 1,969).
Stdlib only. No API key. Outputs Slack mrkdwn on stdout.
"""
import json, os, sys, time, urllib.request, datetime, collections

HERE = os.path.dirname(os.path.abspath(__file__))
MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
EPS  = ["https://api.mainnet-beta.solana.com", "https://docs-demo.solana-mainnet.quiknode.pro/"]
SPAM_MAX = 100_000      # a 15-day-old bot sprays the top holders with ~$1 of PUMP, ~500 transfers/day
HOURS    = int(os.environ.get("PUMP_HOURS", "24"))
MATERIAL = 1_000_000    # only itemise moves above this

def call(method, params, tries=5):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(tries):
        for url in EPS:
            try:
                req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=40) as f:
                    d = json.load(f)
                if "error" in d:
                    continue
                return d["result"]
            except Exception:
                pass
        time.sleep(1.2 * (attempt + 1))
    return None

def price():
    try:
        u = "https://api.coingecko.com/api/v3/simple/price?ids=pump-fun&vs_currencies=usd"
        with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "m"}), timeout=20) as f:
            return json.load(f)["pump-fun"]["usd"]
    except Exception:
        return None

_kind = {}
def kind(a):
    if a in _kind:
        return _kind[a]
    v = call("getAccountInfo", [a, {"encoding": "jsonParsed"}])
    v = v["value"] if v else None
    if not v:                                              k = "closed"
    elif v["owner"] == "11111111111111111111111111111111": k = "wallet"
    else:                                                  k = "pool/program"
    _kind[a] = k
    return k

atamap = json.load(open(os.path.join(HERE, "ata_map.json")))
labels = json.load(open(os.path.join(HERE, "labels.json")))
cohort = set(atamap)
since  = int((datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=HOURS)).timestamp())
px     = price()
pxs    = px if px else 0.0
IN, OUT = collections.defaultdict(float), collections.defaultdict(float)
dust_amt, dust_n, events, seen = 0.0, 0, [], set()
fail = 0

for owner, atas in atamap.items():
    for ata in atas:
        sigs = call("getSignaturesForAddress", [ata, {"limit": 300, "commitment": "finalized"}])
        if sigs is None:
            fail += 1
            continue
        for x in sigs:
            if x["blockTime"] < since:
                break
            if x["signature"] in seen:
                continue
            seen.add(x["signature"])
            t = call("getTransaction", [x["signature"], {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
            if not t or t["meta"].get("err"):
                continue
            d = collections.defaultdict(float)
            for arr, sn in ((t["meta"].get("preTokenBalances") or []), -1), ((t["meta"].get("postTokenBalances") or []), 1):
                for b in arr:
                    if b["mint"] != MINT:
                        continue
                    d[b.get("owner")] += sn * int(b["uiTokenAmount"]["amount"]) / 1e6
            d = {k: v for k, v in d.items() if abs(v) > 1e-9}
            for k, v in d.items():
                if k not in cohort:
                    continue
                if abs(v) < SPAM_MAX:
                    if v > 0:
                        dust_amt += v; dust_n += 1
                    continue
                (IN if v > 0 else OUT)[k] += abs(v)
                cps = [q for q, y in d.items() if (y < 0 if v > 0 else y > 0) and q != k]
                events.append((x["blockTime"], k, v, cps[0] if cps else None))

ti, to = sum(IN.values()), sum(OUT.values())
usd = (lambda a: f"${a*pxs:,.0f}") if px else (lambda a: "n/a")
f = lambda t: datetime.datetime.fromtimestamp(t, datetime.UTC).strftime("%d %b %H:%M")
L = []
L.append(f"*🟣 PUMP insider cohort — {HOURS}h flow*")
L.append(f"_{len(cohort)} wallets · {datetime.datetime.now(datetime.UTC):%d %b %H:%M} UTC · "
         + (f"price ${px:.8f}" if px else "price unavailable") + "_")
L.append("")
L.append(f"• Inflow   `{ti:>16,.0f}` PUMP   {usd(ti)}   _{len(IN)} wallets_")
L.append(f"• Outflow  `{to:>16,.0f}` PUMP   {usd(to)}   _{len(OUT)} wallets_")
L.append(f"• *Net*    `{ti-to:>+16,.0f}` PUMP   *{usd(ti-to)}*")
if fail:
    L.append(f"• ⚠️ {fail} token accounts failed to query — figures are a floor")
if dust_n:
    L.append(f"• _spam dust excluded: {dust_n} transfers, {dust_amt:,.0f} PUMP {usd(dust_amt)}_")
mat = [e for e in events if abs(e[2]) >= MATERIAL]
if not mat:
    L.append("")
    L.append("No material movement (nothing above 1M PUMP).")
else:
    L.append("")
    L.append("*Moves*")
    for t, k, v, cp in sorted(mat, key=lambda z: -abs(z[2]))[:14]:
        who = labels.get(k, k[:12])
        arrow = "IN " if v > 0 else "OUT"
        L.append(f"`{arrow}` *{v:+,.0f}*  {who}")
        if cp:
            L.append(f"      {'from' if v>0 else 'to'} `{cp[:20]}…` [{kind(cp)}]")
L.append("")
L.append("_Flows measured on token accounts, not owners. Transfers under "
         f"{SPAM_MAX:,} PUMP are bot spam and excluded._")
print("\n".join(L))
