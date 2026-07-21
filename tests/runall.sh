#!/bin/bash
# Runs the suites against a throwaway server on :3061.
#
# Each suite gets its OWN fresh database — test-api rotates the admin password
# and several move master prices, so a shared database fails every later login.
# The seed passwords are passed in, never hardcoded: the suites read the same
# env vars.
set -u
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
WORK="${WORK:-/tmp/yajna-tests}"

export SEED_ADMIN_PW="${SEED_ADMIN_PW:-Test@Admin#1}"
export SEED_MANAGER_PW="${SEED_MANAGER_PW:-Test@Manager#1}"
export SEED_USER_PW="${SEED_USER_PW:-Test@User#1}"

mkdir -p "$WORK/data" "$WORK/public"
cp "$ROOT/server.js" "$WORK/server.js"
cp "$ROOT/public/index.html" "$WORK/public/index.html"
ln -sfn "$ROOT/node_modules" "$WORK/node_modules"

: > runall.out
for t in "$@"; do
  P=$(ss -ltnp 2>/dev/null | grep 3061 | grep -o 'pid=[0-9]*' | cut -d= -f2)
  [ -n "$P" ] && kill $P 2>/dev/null
  sleep 0.6
  rm -f "$WORK"/data/*
  # not inside $( ) — the server holds the fd open and the substitution would wait
  ( cd "$WORK" && PORT=3061 exec node --max-old-space-size=768 server.js ) </dev/null >"$WORK/srv.log" 2>&1 &
  sleep 1.8
  node --max-old-space-size=768 "test-$t.mjs" </dev/null >"out-$t.txt" 2>&1
  echo "$t: $(tail -3 "out-$t.txt" | grep -E '[0-9]+ passed')" >> runall.out
done
P=$(ss -ltnp 2>/dev/null | grep 3061 | grep -o 'pid=[0-9]*' | cut -d= -f2); [ -n "$P" ] && kill $P 2>/dev/null
cat runall.out
