#!/usr/bin/env bash
# tubot-cli demo final send, appended to tubot-howto-demo.cast: ch6 went
# REST-silent because slim setup skips the widget stages that VF-equip the
# page; stage 10 has since equipped it, so this send rides the proxy WS leg.
set -u
export PATH="/home/saul/Music/tuff/tubot-cli/dist:$PATH"
export TERM="${TERM:-xterm-256color}"
stty cols 100 rows 30 2>/dev/null || true

banner() { printf '\n===== %s =====\n\n' "$1"; sleep 2; }
run() { printf '$ %s\n' "$*"; sleep 1; "$@"; }

banner "6b/6 send, equipped: page now carries the proxy route (stage 10)"
run tubot send --org tubot-cast-1 --channel Nu_Message_Channel -m "hello" || exit 1

banner "DONE: howto complete - gate green, equipped send answered"
