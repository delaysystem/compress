#!/usr/bin/env bash
# v3 finale, appended: chapter 5's connect check hit the transient backend
# grant blip again (red at 12:14, green on immediate recheck), so rerun the
# gate + send now that setup is fully green on both paths.
set -u
export PATH="/home/saul/Music/tuff/tubot-cli/dist:$PATH"
export TERM="${TERM:-xterm-256color}"

banner() { printf '\n===== %s =====\n\n' "$1"; sleep 2; }
run() { printf '$ %s\n' "$*"; sleep 1; "$@"; }

banner "5b/6 retry: ch5 connect hit transient unverified -> rerun gate"
run tubot verify --org tubot-cast-4 --deployment Nu_Message_Web --yes || exit 1

banner "6/6 send: one visitor message, agent reply as JSON"
run tubot send --org tubot-cast-4 --channel Nu_Message_Channel -m "hello" || exit 1

banner "DONE: take 3 complete - full howto green from zero"
