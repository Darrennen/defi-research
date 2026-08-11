#!/bin/sh
# Weekly EMA 1d-golden watchlist. Driven by launchd (com.ema.watchlist).
#
# Runs locally rather than as a Claude cloud routine because Binance is
# unreachable from the Anthropic sandbox -- both api.binance.com and
# data-api.binance.vision fail to connect there (verified 2026-08-11).
# Running local also costs zero routine-completion notifications: this is
# silent unless there is actually a new cross.
#
# Delivery, in order of preference:
#   1. Slack, if `secret set slack-webhook` has been run (an incoming-webhook URL)
#   2. macOS notification, otherwise
# Either way the report is appended to data/watchlist.log.

set -u
cd "$(dirname "$0")" || exit 1
mkdir -p data
LOG=data/run.log

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG"; }

notify() {  # notify <title> <message>
    hook=$(secret get slack-webhook 2>/dev/null) || hook=""
    if [ -n "$hook" ]; then
        SLACK_TEXT="$2" python3 -c 'import json,os,sys,urllib.request
url=sys.argv[1]
body=json.dumps({"text":os.environ["SLACK_TEXT"]}).encode()
req=urllib.request.Request(url,data=body,headers={"Content-Type":"application/json"})
urllib.request.urlopen(req,timeout=20).read()' "$hook" 2>>"$LOG" && { say "delivered via slack"; return; }
        say "slack post failed, falling back to notification"
    fi
    osascript -e "display notification \"$1\" with title \"EMA watchlist\"" 2>>"$LOG"
    say "delivered via macOS notification"
}

say "--- run start"

# Pick the host and concurrency together. api.binance.com allows 6000 weight/min
# and takes 10 workers happily. data-api.binance.vision serves identical klines
# but has a far smaller budget -- at 10 workers it IP-bans within seconds, and
# the ban shows up as dropped connections rather than a 429, so the scanner's
# own throttle never sees it (2026-08-11: lost 2006 of 2130 series that way).
# So probe the fast host and only use the mirror at low concurrency.
if curl -fsS -m 10 -o /dev/null \
     "https://api.binance.com/api/v3/ping" 2>/dev/null; then
    HOST=https://api.binance.com
    WORKERS=10
else
    HOST=https://data-api.binance.vision
    WORKERS=2
fi
say "host=$HOST workers=$WORKERS"

if ! BINANCE_HOST="$HOST" python3 scanner.py --venue binance --workers "$WORKERS" >>"$LOG" 2>&1; then
    say "SCAN FAILED"
    notify "Scan failed - see data/run.log" "*EMA watchlist:* scan failed. See \`data/run.log\`."
    exit 1
fi

# No --no-state here: locally the dedupe state persists, so one cross is
# reported once rather than every week for the 20 days its grade lives.
OUT=$(python3 alert.py 2>>"$LOG")
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
    say "ALERT FAILED (exit $STATUS)"
    notify "alert.py failed - see data/run.log" "*EMA watchlist:* \`alert.py\` exited $STATUS. See \`data/run.log\`."
    exit 1
fi

if [ -z "$OUT" ]; then
    say "no new qualifying crosses"   # the normal case; stay silent
    exit 0
fi

printf '\n===== %s =====\n%s\n' "$(date '+%Y-%m-%d')" "$OUT" >>data/watchlist.log
say "reporting $(printf '%s' "$OUT" | grep -c '^\*[A-Z]') cross(es)"
notify "New 1d golden cross - see data/watchlist.log" "$OUT"
