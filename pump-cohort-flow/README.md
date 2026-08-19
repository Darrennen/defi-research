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
