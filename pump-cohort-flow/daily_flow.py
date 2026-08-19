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
known  = json.load(open(os.path.join(HERE, "known.json")))
DISTRIBUTORS = {"GsM3emTijQshDHrWRRhSQhqG1zYC9BNnAuah7ZPEu6ya": "distributor A",
                "ESRc4ce6jpyRyvGJ9Gjgtmwc7wEtR1ZPaQPnh9kWZM67": "distributor B"}
EXCHANGES = {"5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": "Binance",
             "6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF": "unattributed exchange"}
_age = {}
def first_seen(a):
    """days since the account's oldest visible signature; None if unknown."""
    if a in _age: return _age[a]
    s2 = call("getSignaturesForAddress", [a, {"limit": 1000, "commitment": "finalized"}])
    v = None
    if s2:
        oldest = s2[-1]["blockTime"]
        if len(s2) < 1000:   # only meaningful when we reached the true start
            v = (datetime.datetime.now(datetime.UTC).timestamp() - oldest) / 86400
    _age[a] = v
    return v
cohort = set(atamap)
since  = int((datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=HOURS)).timestamp())
px     = price()
pxs    = px if px else 0.0
IN, OUT = collections.defaultdict(float), collections.defaultdict(float)
dust_amt, dust_n, events, seen = 0.0, 0, [], set()
dust_by_sender = collections.defaultdict(lambda: {"n": 0, "amt": 0.0, "hit": set()})
outdest = collections.defaultdict(float)
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
                        src = [q for q, y in d.items() if y < 0]
                        if src:
                            e = dust_by_sender[src[0]]
                            e["n"] += 1; e["amt"] += v; e["hit"].add(k)
                    continue
                (IN if v > 0 else OUT)[k] += abs(v)
                cps = [q for q, y in d.items() if (y < 0 if v > 0 else y > 0) and q != k]
                if v < 0 and cps:
                    outdest[cps[0]] += abs(v)
                events.append((x["blockTime"], k, v, cps[0] if cps else None))

# distributor watch - a payout to an address outside the cohort means the cohort grew
new_recipients = collections.defaultdict(float)
for dist in DISTRIBUTORS:
    r = call("getTokenAccountsByOwner", [dist, {"mint": MINT}, {"encoding": "jsonParsed", "commitment": "finalized"}])
    for tok in (r["value"] if r else []):
        sg = call("getSignaturesForAddress", [tok["pubkey"], {"limit": 200, "commitment": "finalized"}]) or []
        for x in sg:
            if x["blockTime"] < since: break
            t = call("getTransaction", [x["signature"], {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
            if not t or t["meta"].get("err"): continue
            d = collections.defaultdict(float)
            for arr, sn in ((t["meta"].get("preTokenBalances") or []), -1), ((t["meta"].get("postTokenBalances") or []), 1):
                for b in arr:
                    if b["mint"] != MINT: continue
                    d[b.get("owner")] += sn * int(b["uiTokenAmount"]["amount"]) / 1e6
            for k, v in d.items():
                if v > SPAM_MAX and k not in cohort and k not in DISTRIBUTORS:
                    new_recipients[k] += v

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
# ---------- anomalies ----------
anom = []
for snd, e in sorted(dust_by_sender.items(), key=lambda z: -len(z[1]["hit"])):
    if len(e["hit"]) >= 15:
        anom.append(f"*Dust spray* — `{snd[:20]}…` hit *{len(e['hit'])} of {len(cohort)}* cohort wallets, "
                    f"{e['n']} transfers, {e['amt']:,.0f} PUMP {usd(e['amt'])}. Attribution spam, not insider flow.")
for k in OUT:
    if "holds all" in labels.get(k, ""):
        anom.append(f"*Behaviour change* — {labels[k]} sent PUMP out for the first time "
                    f"({OUT[k]:,.0f} PUMP {usd(OUT[k])}). Its label says it had never moved.")
for dest, amt in sorted(outdest.items(), key=lambda z: -z[1]):
    if dest in EXCHANGES:
        anom.append(f"*Exchange deposit* — {amt:,.0f} PUMP {usd(amt)} reached {EXCHANGES[dest]} `{dest[:16]}…`. "
                    f"A deposit is not a fill; the sale price is not observable.")
    elif dest not in known:
        age = first_seen(dest)
        agetxt = f"created {age:.1f} days ago" if age is not None and age < 14 else "not in the known-address map"
        anom.append(f"*New counterparty* — {amt:,.0f} PUMP {usd(amt)} to `{dest[:20]}…` ({agetxt}, {kind(dest)}).")
for k, v in sorted(new_recipients.items(), key=lambda z: -z[1]):
    anom.append(f"*Cohort grew* — a distributor paid `{k[:20]}…` {v:,.0f} PUMP {usd(v)}, "
                f"an address not in the tracked 129. Add it.")
if anom:
    L.append("")
    L.append("*⚠️ Worth a look*")
    for a in anom[:10]:
        L.append(f"• {a}")
L.append("")
L.append("_Flows measured on token accounts, not owners. Transfers under "
         f"{SPAM_MAX:,} PUMP are bot spam and excluded._")
print("\n".join(L))
