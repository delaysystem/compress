#!/usr/bin/env bash
# tubot-cli demo: scratch org from zero to green, recorded with asciinema.
# Runs the real commands from tubot-cli/scratch-setup-howto.txt (plus --yes
# so the recording never blocks on a prompt, and -- --fast on setup, the
# documented slim e2e matrix with the ~1000s goal).
set -u
export PATH="/home/saul/Music/tuff/tubot-cli/dist:$PATH"
export TERM="${TERM:-xterm-256color}"
stty cols 100 rows 30 2>/dev/null || true

ORG="tubot-cast-1"
AGENT="Coral_Cloud_Employee_Agent"
CHANNEL="Nu_Message_Channel"
DEPLOYMENT="Nu_Message_Web"

banner() { printf '\n===== %s =====\n\n' "$1"; sleep 2; }
run() { printf '$ %s\n' "$*"; sleep 1; "$@"; }

banner "tubot-cli: scratch org from zero to green (howto)"
echo "Org: $ORG  |  agent: $AGENT  |  channel: $CHANNEL  |  deployment: $DEPLOYMENT"
sleep 2

banner "1/6 login (one-time, already done) -> status proves the stored key"
run tubot status || exit 1

banner "2/6 scratch-setup: build + discover + native A1 chat proof"
echo "(--no-snapshot: Dev Hub snapshot quota is full at 5/5, so we skip the"
echo " optional freeze step; every functional step still runs.)"
sleep 2
run tubot scratch-setup "$ORG" --no-snapshot --yes || exit 1

banner "3/6 what the build created: channels + agents"
run tubot channels "$ORG" || exit 1
run tubot agents "$ORG" || exit 1

banner "4/6 setup: provision fixtures + headless e2e suite (fast matrix)"
run tubot setup "$ORG" --agent "$AGENT" --channels "$CHANNEL" --yes -- --fast || exit 1

banner "5/6 verify: live gate (browser checks + provision x2)"
run tubot verify --org "$ORG" --deployment "$DEPLOYMENT" --yes || exit 1

banner "6/6 send: one visitor message, agent reply as JSON"
run tubot send --org "$ORG" --channel "$CHANNEL" -m "hello" || exit 1

banner "DONE: all six chapters green"
