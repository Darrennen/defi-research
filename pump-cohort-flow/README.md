# PUMP insider cohort — daily flow

Measures 24h PUMP inflow/outflow for the 129-wallet pump.fun insider cohort (the 14 Jul 2026
cliff recipients from both distributors, plus post-cliff recipients).

    python3 daily_flow.py            # last 24h, Slack mrkdwn on stdout
    PUMP_HOURS=48 python3 daily_flow.py

Stateless — recomputed from chain each run. Stdlib only, no API key.

## Two rules that must not be relaxed

1. **Query token accounts, not owners.** An inbound SPL transfer references the source ATA,
   destination ATA and authority. The destination *owner* is never an account key, so
   `getSignaturesForAddress` on the owner silently misses every inbound transfer. `ata_map.json`
   maps owner -> PUMP token account.
2. **Never use `solana-rpc.publicnode.com`.** It returns truncated `getSignaturesForAddress`
   results with no error — 41 signatures where the true count was 1,969. Always pass
   `commitment: finalized`.

## Spam filter

A sniper bot sprays the top PUMP holders with roughly $1 of real PUMP, ~500 transfers a day,
which lands on these wallets because they are large holders. Transfers under 100,000 PUMP are
counted separately as dust and excluded from the flow totals. Do not remove this filter.

## Files

- `ata_map.json` — 129 owners -> PUMP token accounts
- `labels.json` — address -> "PUMP Team 2.08B - Binance exit" style label

## Anomaly detection

The flow totals hide things, so the report ends with a "Worth a look" section that fires only
when something trips. Five checks:

1. **Dust spray** — one sender hitting 15+ cohort wallets with sub-threshold transfers. Reports
   how many wallets it reached out of 129. This is how the `5KXDF6Qn…` sniper bot shows up: ~919
   transfers a day across ~53 wallets, roughly $1,200 total. Attribution spam, not insider flow.
2. **Behaviour change** — a wallet whose label says "holds all" sending PUMP out for the first
   time. The single most meaningful thing that can happen in this cohort.
3. **Exchange deposit** — anything reaching Binance or the unattributed `6LY1JzAF…` terminus,
   always stated as a deposit rather than a sale, because the fill price is not observable.
4. **New counterparty** — material outflow to an address absent from `known.json`, with its
   account age when the account is young enough to date.
5. **Cohort grew** — either distributor paying an address outside the tracked 129. That happened
   twice in the August tranche and is how the set should be kept current.
