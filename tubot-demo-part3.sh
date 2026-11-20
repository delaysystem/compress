#!/usr/bin/env bash
# tubot-cli demo completion, appended to tubot-howto-demo.cast: note the
# agent-side 09 finding, then run the remaining howto chapters (verify + send).
set -u
export PATH="/home/saul/Music/tuff/tubot-cli/dist:$PATH"
export TERM="${TERM:-xterm-256color}"
stty cols 100 rows 30 2>/dev/null || true

ORG="tubot-cast-1"
CHANNEL="Nu_Message_Channel"
DEPLOYMENT="Nu_Message_Web"

banner() { printf '\n===== %s =====\n\n' "$1"; sleep 2; }
run() { printf '$ %s\n' "$*"; sleep 1; "$@"; }

banner "4c/6 note: stage 09 is red for an AGENT-side reason (see below)"
echo "GetRecordDetails declined 4/4 with its fixture present and 8/9 actions"
echo "passing real replies - Salesforce-agent behavior, not TuBot plumbing."
echo "Proceeding to the live gate + send, which is the system's own proof."
sleep 3

banner "5/6 verify: live gate (browser checks + provision x2)"
run tubot verify --org "$ORG" --deployment "$DEPLOYMENT" --yes || exit 1

banner "6/6 send: one visitor message, agent reply as JSON"
run tubot send --org "$ORG" --channel "$CHANNEL" -m "hello" || exit 1

banner "DONE: howto complete (1-6 executed; 09 agent-side red noted above)"
