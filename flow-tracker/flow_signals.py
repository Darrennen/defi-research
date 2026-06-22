#!/usr/bin/env python3
"""
Flow Tracker — the two signals that decide bear-deepens vs bottoms:
  1) Stablecoin aggregate supply (dry powder)  -> DefiLlama (free)
  2) BTC structure: 200W MA / Mayer / drawdown -> CoinGecko (free)
ETF AUM/flow is passed in via --etf-aum-now / --etf-aum-week (from CoinMarketCap),
since no free public BTC-spot-ETF flow API exists without a key.

Signal-first output. Real data only; missing data is labeled, never guessed.
"""
import urllib.request, json, argparse, sys

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    return json.load(urllib.request.urlopen(req, timeout=40))

def stablecoin_signal():
    d = get("https://stablecoins.llama.fi/stablecoincharts/all")
    def tot(x):
        v = x.get('totalCirculatingUSD')
        return (v.get('peggedUSD') if isinstance(v, dict) else v) / 1e9
    now, w, m = tot(d[-1]), tot(d[-8]), tot(d[-31])
    d7, d30 = (now/w - 1)*100, (now/m - 1)*100
    if d30 > 1.5:   read = "EXPANDING — dry powder building, supportive of a bottom/rally"
    elif d30 < -1:  read = "CONTRACTING — capital exiting crypto entirely, near-term bearish"
    else:           read = "FLAT — sidelined, waiting"
    return dict(now=now, d7=d7, d30=d30, read=read)

def btc_signal():
    # Binance public klines — keyless, reliable. Weekly for 200W MA, daily for Mayer.
    wk = get("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=1000")
    dy = get("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=200")
    wk_close = [float(k[4]) for k in wk]
    dy_close = [float(k[4]) for k in dy]
    cur = dy_close[-1]
    ma200d = sum(dy_close[-200:]) / 200
    ma200w = sum(wk_close[-200:]) / 200
    ath = max(float(k[2]) for k in wk)  # weekly highs
    return dict(
        price=cur, ma200w=ma200w, pct_200w=(cur/ma200w-1)*100,
        mayer=cur/ma200d, dd_ath=(cur/ath-1)*100, ath=ath,
        # historical floor refs computed earlier from full history
        floor_covid=ma200w*0.91, floor_bear22=ma200w*0.658,
    )

def fmt(s, b, e=None):
    L = []
    L.append("📡 *FLOW TRACKER* — bear-deepens vs bottoms signals\n")

    # ETF (passed in)
    L.append("*1. BTC ETF demand* — the swing factor")
    if e and e.get('now'):
        chg = e['now'] - e['week'] if e.get('week') else None
        arrow = "🔴" if (chg is not None and chg < 0) else ("🟢" if chg else "⚪")
        line = f"   AUM ${e['now']:.1f}B"
        if chg is not None:
            line += f"  ({chg:+.1f}B WoW)  {arrow}"
        L.append(line)
        if chg is not None:
            L.append("   " + ("Outflows persisting → bear risk live" if chg < -1 else
                              "Inflows returning → bottoming tell" if chg > 1 else
                              "Stabilizing → watch for the turn"))
    else:
        L.append("   ⚠️ ETF AUM not supplied (pass --etf-aum-now / --etf-aum-week from CMC)")

    # Stablecoins
    L.append("\n*2. Stablecoin supply* — dry powder")
    L.append(f"   ${s['now']:.1f}B   7d {s['d7']:+.1f}%   30d {s['d30']:+.1f}%")
    L.append(f"   {s['read']}")

    # BTC structure
    L.append("\n*3. BTC structure* — where price sits vs the floor")
    L.append(f"   ${b['price']:,.0f}   |   {b['dd_ath']:+.0f}% from ATH (${b['ath']:,.0f})")
    L.append(f"   200W MA ${b['ma200w']:,.0f}  ({b['pct_200w']:+.1f}% {'above 🟢' if b['pct_200w']>=0 else 'BELOW 🔴'})")
    L.append(f"   Mayer {b['mayer']:.2f}  ({'cheap' if b['mayer']<1 else 'rich'}; bottoms ~0.5-0.6)")
    L.append(f"   Hist floors: COVID-style ~${b['floor_covid']:,.0f} | 2022-bear ~${b['floor_bear22']:,.0f}")
    return "\n".join(L)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--etf-aum-now", type=float, default=None)
    ap.add_argument("--etf-aum-week", type=float, default=None)
    a = ap.parse_args()
    try:
        s = stablecoin_signal()
        b = btc_signal()
    except Exception as ex:
        print("DATA ERROR:", ex, file=sys.stderr); sys.exit(1)
    e = {"now": a.etf_aum_now, "week": a.etf_aum_week} if a.etf_aum_now else None
    print(fmt(s, b, e))
