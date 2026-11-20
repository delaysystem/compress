#!/usr/bin/env bash
# tubot-cli demo finale, appended to tubot-howto-demo.cast: retry the one
# red stage (09 missed its 10s reply budget under two-suite load), then run
# the remaining howto chapters (verify + send) to green.
set -u
export PATH="/home/saul/Music/tuff/tubot-cli/dist:$PATH"
export TERM="${TERM:-xterm-256color}"
stty cols 100 rows 30 2>/dev/null || true

ORG="tubot-cast-1"
CHANNEL="Nu_Message_Channel"
DEPLOYMENT="Nu_Message_Web"

banner() { printf '\n===== %s =====\n\n' "$1"; sleep 2; }
run() { printf '$ %s\n' "$*"; sleep 1; "$@"; }

banner "4b/6 retry: stage 09 over its 10s reply budget -> rerun it alone"
echo "(pins mirror what setup exports internally, so the standalone stage"
echo " runs under identical conditions)"
export AGENT_MATCH="Coral_Cloud_Employee_Agent"
export CHANNEL_MATCH="Nu_Message_Channel"
run tubot stage 09-coral-agent --org "$ORG" --path normal --yes || exit 1

banner "5/6 verify: live gate (browser checks + provision x2)"
run tubot verify --org "$ORG" --deployment "$DEPLOYMENT" --yes || exit 1

banner "6/6 send: one visitor message, agent reply as JSON"
run tubot send --org "$ORG" --channel "$CHANNEL" -m "hello" || exit 1

banner "DONE: finale green (4b + 5 + 6)"
