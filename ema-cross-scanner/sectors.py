#!/usr/bin/env python3
"""Sector / asset-class tags from CoinGecko categories, cached to disk.

Used to separate genuine crypto from tokenized real-world assets. That separation
matters: benchmark.py validated the signal rules on crypto only, so a tokenized
equity must not inherit a crypto-derived verdict.
"""

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

CACHE = Path(__file__).parent / "data" / "sectors.json"
TTL = 24 * 3600
CG = "https://api.coingecko.com/api/v3/coins/markets"

# category id -> asset class. "rwa" is a flag rather than a class: an RWA
# infrastructure token (ONDO, PLUME) is still crypto and still benchmarkable.
CATEGORIES = {
    "real-world-assets-rwa": "rwa",
    "tokenized-stock": "equity",
    "tokenized-pre-ipo-stocks": "equity",
    "tokenized-exchange-traded-funds-etfs": "equity",
    "tokenized-exchange-traded-product-etps": "equity",
    "tokenized-gold": "commodity",
    "tokenized-silver": "commodity",
    "tokenized-commodities": "commodity",
    "tokenized-treasuries": "treasury",
    "tokenized-t-bills": "treasury",
    "tokenized-money-market-fund-mmfs": "treasury",
}


def _fetch(cat, retries=4):
    url = f"{CG}?vs_currency=usd&category={cat}&per_page=250&page=1"
    req = urllib.request.Request(url, headers={"User-Agent": "ema-scanner/1.0"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                d = json.loads(r.read())
            if not isinstance(d, list):
                raise RuntimeError(f"CoinGecko returned {d}")
            return sorted({c["symbol"].upper() for c in d if c.get("symbol")})
        except urllib.error.HTTPError as e:
            if e.code == 429:          # free tier is ~10-30 calls/min
                time.sleep(25 * (attempt + 1))
                continue
            raise
    raise RuntimeError("rate limited after retries")


def load(refresh=False):
    """{'rwa': [...], 'equity': [...], ...} of uppercase symbols."""
    if CACHE.exists() and not refresh:
        blob = json.loads(CACHE.read_text())
        if time.time() - blob.get("fetched_at", 0) < TTL:
            return blob["sets"]

    # Start from whatever is cached so a partially rate-limited run still accumulates.
    sets = {}
    if CACHE.exists():
        sets = {k: set(v) for k, v in json.loads(CACHE.read_text())["sets"].items()}
    for cat, cls in CATEGORIES.items():
        try:
            syms = _fetch(cat)
        except Exception as e:
            print(f"  sectors: {cat} failed ({e})")
            continue
        sets.setdefault(cls, set()).update(syms)
        time.sleep(8)   # CoinGecko free tier is ~10-30 calls/min

    sets = {k: sorted(v) for k, v in sets.items()}
    if not sets:
        # Never overwrite a good cache with nothing.
        if CACHE.exists():
            return json.loads(CACHE.read_text())["sets"]
        return {}
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps({"fetched_at": int(time.time()), "sets": sets}))
    return sets


def classify(sets):
    """Return a fn mapping a base symbol -> (asset_class, is_rwa)."""
    eq = set(sets.get("equity", []))
    co = set(sets.get("commodity", []))
    tr = set(sets.get("treasury", []))
    rwa = set(sets.get("rwa", [])) | eq | co | tr

    def f(base):
        b = base.upper()
        if b in eq:
            return "equity", True
        if b in co:
            return "commodity", True
        if b in tr:
            return "treasury", True
        return "crypto", b in rwa

    return f


if __name__ == "__main__":
    s = load(refresh=True)
    for k, v in s.items():
        print(f"{k:10} {len(v):4} symbols  e.g. {v[:12]}")
