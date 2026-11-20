#!/usr/bin/env bash
# tubot-cli demo gate retry, appended to tubot-howto-demo.cast: chapter 5's
# connect check hit a transient backend-grant blip (both orgs unverifiable
# for ~2 min, green again on immediate recheck), so rerun gate + send.
set -u
export PATH="/home/saul/Music/tuff/tubot-cli/dist:$PATH"
export TERM="${TERM:-xterm-256color}"
stty cols 100 rows 30 2>/dev/null || true

ORG="tubot-cast-1"
CHANNEL="Nu_Message_Channel"
DEPLOYMENT="Nu_Message_Web"

banner() { printf '\n===== %s =====\n\n' "$1"; sleep 2; }
run() { printf '$ %s\n' "$*"; sleep 1; "$@"; }

banner "5b/6 retry: ch5 red was transient backend unverified -> rerun gate"
run tubot verify --org "$ORG" --deployment "$DEPLOYMENT" --yes || exit 1

banner "6/6 send: one visitor message, agent reply as JSON"
run tubot send --org "$ORG" --channel "$CHANNEL" -m "hello" || exit 1

banner "DONE: howto complete (09 agent-side red noted in 4c; gate green)"
