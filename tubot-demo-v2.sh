#!/usr/bin/env bash
# tubot-cli demo v2: full howto from zero on a fresh org (full setup exactly
# as scratch-setup-howto.txt prescribes - no --fast, so widget stages equip
# the page and the closing send answers). Record with:
#   asciinema rec --overwrite --idle-time-limit 3 \
#     --title "tubot-cli: scratch org from zero to green, take 2 (howto)" \
#     --command ./tubot-demo-v2.sh tubot-howto-demo-v2.cast
set -u
export PATH="/home/saul/Music/tuff/tubot-cli/dist:$PATH"
export TERM="${TERM:-xterm-256color}"

ORG="tubot-cast-2"
AGENT="Coral_Cloud_Employee_Agent"
CHANNEL="Nu_Message_Channel"
DEPLOYMENT="Nu_Message_Web"

banner() { printf '\n===== %s =====\n\n' "$1"; sleep 2; }
run() { printf '$ %s\n' "$*"; sleep 1; "$@"; }

banner "tubot-cli: scratch org from zero to green, take 2 (howto)"
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

banner "4/6 setup: provision fixtures + FULL headless e2e suite (both paths)"
run tubot setup "$ORG" --agent "$AGENT" --channels "$CHANNEL" --yes || exit 1

banner "5/6 verify: live gate (browser checks + provision x2)"
run tubot verify --org "$ORG" --deployment "$DEPLOYMENT" --yes || exit 1

banner "6/6 send: one visitor message, agent reply as JSON"
run tubot send --org "$ORG" --channel "$CHANNEL" -m "hello" || exit 1

banner "DONE: all six chapters green"
