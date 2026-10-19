#!/usr/bin/env bash
# E2E gauntlet for fleet-base — exercises the whole base in one go:
# health, live model catalog, multi-round tool loop, cross-run memory,
# agent isolation, idempotency, reset. (Crash resume is manual; see README.)
#
# Usage:
#   bash scripts/e2e-gauntlet.sh [host:port]   # default localhost:9876 (celld dev)
#   bash scripts/e2e-gauntlet.sh localhost:8080  # bucket-backed node
#
# Safe: `exit` here ends only this script, never your shell.

set -u
BASE="${1:-localhost:9876}"
AGENT="e2e-$(date +%s)"
OTHER="e2e-other-$(date +%s)"
TMPD="$(mktemp -d)"
FAILS=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
need() { command -v "$1" >/dev/null || { echo "missing required tool: $1"; exit 2; }; }
need curl
need python3

echo "== base: $BASE | agent: $AGENT =="

echo "--- 1. health + live catalog ---"
if [ "$(curl -s -m 10 "$BASE/health")" = "ok" ]; then
  pass "health"
else
  fail "health (is the server running at $BASE?)"
fi
curl -s -m 15 "$BASE/models" > "$TMPD/models.json" &&
  python3 -c "
import json
m = json.load(open('$TMPD/models.json'))
assert m['router']['live'], 'router live is null'
print('   default:', m['default'], '| live sample:', m['router']['live'][:3])
" &&
  pass "live router catalog" ||
  fail "live router catalog"

echo "--- 2. multi-round tool loop (3 separate echo calls) ---"
curl -s -m 180 -X POST "$BASE/agent/$AGENT/prompt" -H 'content-type: application/json' \
  -d '{"prompt":"Call the echo tool in three separate calls with the words zephyr, quark, eight (one word per call), then reply with ONLY the three words comma-separated."}' > "$TMPD/r1.json" &&
  python3 -c "
import json
t = json.load(open('$TMPD/r1.json'))
assert t['status'] == 'done', t
assert all(w in t['text'] for w in ['zephyr', 'quark', 'eight']), t['text']
print('  ', repr(t['text']))
" &&
  pass "3-round tool loop" ||
  fail "3-round tool loop"

echo "--- 3. cross-run memory (same agent, new run) ---"
curl -s -m 180 -X POST "$BASE/agent/$AGENT/prompt" -H 'content-type: application/json' \
  -d '{"prompt":"What were the three words from your previous reply? Reply with ONLY them, comma-separated."}' > "$TMPD/r2.json" &&
  python3 -c "
import json
t = json.load(open('$TMPD/r2.json'))
assert t['status'] == 'done', t
assert all(w in t['text'] for w in ['zephyr', 'quark', 'eight']), t['text']
print('  ', repr(t['text']))
" &&
  pass "cross-run memory" ||
  fail "cross-run memory"

echo "--- 4. isolation (different agent must not know) ---"
curl -s -m 180 -X POST "$BASE/agent/$OTHER/prompt" -H 'content-type: application/json' \
  -d '{"prompt":"What three words did I give you earlier? If none, reply with ONLY the word NONE."}' > "$TMPD/r3.json" &&
  python3 -c "
import json
t = json.load(open('$TMPD/r3.json'))
assert 'zephyr' not in t['text'], t['text']
print('  ', repr(t['text'][:80]))
" &&
  pass "agent isolation" ||
  fail "agent isolation"

echo "--- 5. idempotency (same requestId twice) ---"
RID="e2e-req-$(date +%s)"
curl -s -m 180 -X POST "$BASE/agent/$AGENT/prompt" -H 'content-type: application/json' \
  -d "{\"prompt\":\"say idem\",\"requestId\":\"$RID\"}" > "$TMPD/a.json"
curl -s -m 60 -X POST "$BASE/agent/$AGENT/prompt" -H 'content-type: application/json' \
  -d "{\"prompt\":\"say idem\",\"requestId\":\"$RID\"}" > "$TMPD/b.json"
python3 -c "
import json
a = json.load(open('$TMPD/a.json'))
b = json.load(open('$TMPD/b.json'))
assert a['submissionId'] == b['submissionId'], (a, b)
assert a['text'] == b['text'], (a, b)
print('   submission:', a['submissionId'])
" &&
  pass "idempotent replay" ||
  fail "idempotent replay"

echo "--- 7. reset (transcript wiped, works fresh after) ---"
curl -s -m 30 -X POST "$BASE/agent/$AGENT/reset" > "$TMPD/reset.json" &&
  python3 -c "
import json
assert json.load(open('$TMPD/reset.json'))['reset'] is True
" &&
  pass "reset" ||
  fail "reset"
curl -s -m 30 "$BASE/agent/$AGENT/messages?limit=3" > "$TMPD/empty.json" &&
  python3 -c "
import json
assert json.load(open('$TMPD/empty.json'))['messages'] == [], 'transcript not empty'
" &&
  pass "transcript empty after reset" ||
  fail "transcript empty after reset"

rm -rf "$TMPD"
echo "== $AGENT: $FAILS failure(s) =="
[ "$FAILS" = "0" ] || exit 1
