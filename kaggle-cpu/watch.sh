#!/bin/bash
# watch.sh — poll Kaggle kernels, auto-diagnose on terminal state.
# Errors surface within ~60s of the kernel dying, with a known-cause verdict.
#
# Usage:
#   ./watch.sh [--stall-hours N] <owner/slug> [<owner/slug> ...]
#   ./watch.sh --diagnose-only <logfile> [<logfile> ...]   # offline test/demo
#
# Terminal verdicts go to stdout (one MONITOR event each). Poll heartbeats go
# only to /tmp/kwatch/watch.log so long runs stay silent until news happens.
set -u

POLL=60
STALL_H=8
DIAG_ONLY=0
KERNELS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --diagnose-only) DIAG_ONLY=1; shift ;;
    --stall-hours) STALL_H="$2"; shift 2 ;;
    *) KERNELS+=("$1"); shift ;;
  esac
done

LOGDIR=/tmp/kwatch
mkdir -p "$LOGDIR"
HEARTBEAT="$LOGDIR/watch.log"

# split_log <logfile> <outprefix> — kernel logs are one JSON array with
# stream_name per entry. Split stdout (runtime prints) from stderr
# (tracebacks/debug) so source lines echoed inside tracebacks can't fake
# progress markers. Falls back to raw grep on non-JSON input.
split_log() {
  if jq -e . "$1" >/dev/null 2>&1; then
    jq -r '.[] | select(.stream_name=="stdout") | .data' "$1" > "$2.out"
    jq -r '.[] | select(.stream_name=="stderr") | .data' "$1" > "$2.err"
  else
    cp "$1" "$2.out"; cp "$1" "$2.err"
  fi
}

# furthest <stdout-file> — report how far the kernel got (progress markers).
furthest() {
  local f="$1" marks=""
  grep -q 'eval set OK' "$f" && marks="$marks eval-set-ok"
  grep -q 'downloading' "$f" && marks="$marks downloading"
  grep -q 'downloaded' "$f" && marks="$marks downloaded"
  grep -q 'READY' "$f" && marks="$marks server-ready"
  grep -qE "SMOKE OK|[a-z0-9]+ smoke: '" "$f" && marks="$marks smoke"
  local prog
  prog=$(grep -oE '[0-9]+/(45|90)(, [0-9]+ errors| rows)?' "$f" | tail -1)
  [ -n "$prog" ] && marks="$marks progress[$prog]"
  grep -qE 'ALL DONE|^done' "$f" && marks="$marks done"
  echo "${marks:-nothing (died before first marker)}"
}

# diagnose <stdout> <stderr> <kernel-id> <status> — print CAUSE verdict.
diagnose() {
  local out="$1" err="$2" id="$3" status="$4"
  echo "--- $id [$status] ---"
  echo "reached: $(furthest "$out")"
  local tb=0
  grep -q -i 'Traceback\|PapermillExecutionError' "$err" "$out" && tb=1
  if [ "$status" = COMPLETE ] && [ "$tb" = 0 ]; then
    echo "CAUSE: none — COMPLETE with no traceback; verify output rows next"
    return 0
  fi
  if grep -q "No module named 'sse_starlette'\|No module named 'starlette_context'" "$err" "$out"; then
    echo "CAUSE: server deps missing — add llama-cpp-python[server] + sse-starlette/starlette-context/fastapi/uvicorn backstop to the installer cell"
    return 0
  fi
  if grep -q "No such file or directory: '/kaggle/input/" "$err" "$out" && ! grep -q '/kaggle/input/datasets/' "$err" "$out"; then
    echo "CAUSE: flat dataset path dead — mounts are nested at /kaggle/input/datasets/<owner>/<slug>/"
    return 0
  fi
  if grep -q "No such file or directory: '/kaggle/input/" "$err" "$out"; then
    echo "CAUSE: dataset not mounted — check dataset_sources in kernel-metadata + dataset readiness"
    return 0
  fi
  if grep -q 'error budget exceeded' "$err" "$out"; then
    echo "CAUSE: eval loop failing — see row errors in stdout; check server log tail + smoke quality"
    return 0
  fi
  if grep -q 'server did not come up' "$err" "$out"; then
    echo "CAUSE: server hang (OOM? bad GGUF? arch mismatch?) — see server log tail in kernel log"
    return 0
  fi
  if grep -q -i 'out of memory\|cuda out of memory\|Killed' "$err" "$out"; then
    echo "CAUSE: OOM — reduce N_CTX, smaller quant, or fewer parallel loads"
    return 0
  fi
  if grep -q -i 'huggingface_hub.*\(404\|not found\|NotFound\|HFValidationError\)\|EntryNotFound\|FileNotFound.*hub' "$err" "$out"; then
    echo "CAUSE: bad HF repo/filename — verify GGUF filename exists in the repo"
    return 0
  fi
  if [ "$tb" = 0 ]; then
    echo "CAUSE: none found — no traceback in this log; kernel may be healthy, verify output rows"
    return 0
  fi
  echo "CAUSE: UNKNOWN — newest stderr error lines:"
  grep -i 'Error\|Exception\|assert' "$err" | tail -5 | cut -c1-220
  return 1
}

if [ "$DIAG_ONLY" = 1 ]; then
  for f in "${KERNELS[@]}"; do
    split_log "$f" "$LOGDIR/diag-tmp"
    diagnose "$LOGDIR/diag-tmp.out" "$LOGDIR/diag-tmp.err" "$f" UNKNOWN
  done
  exit 0
fi

if [ "${#KERNELS[@]}" = 0 ]; then echo "usage: watch.sh [--stall-hours N] <owner/slug> ..." >&2; exit 2; fi

echo "WATCHING ${KERNELS[*]} (poll ${POLL}s, stall-warn ${STALL_H}h)"
START=$(date +%s)
declare -A DONE
PENDING=${#KERNELS[@]}
warned_stall=0
while [ "$PENDING" -gt 0 ]; do
  for id in "${KERNELS[@]}"; do
    [ -n "${DONE[$id]:-}" ] && continue
    s=$(kaggle kernels status "$id" 2>/dev/null || echo STATUS_FETCH_FAILED)
    echo "$(date -u +%H:%M:%S) $id :: $s" >> "$HEARTBEAT"
    case "$s" in
      *COMPLETE*|*ERROR*)
        DONE[$id]=1; PENDING=$((PENDING - 1))
        slug="${id##*/}"
        outdir="$LOGDIR/$slug"
        mkdir -p "$outdir"
        echo "TERMINAL $id :: $s"
        if kaggle kernels output "$id" -p "$outdir" >/dev/null 2>&1; then
          echo "fetched: $(ls "$outdir" | tr '\n' ' ')"
          log=$(ls "$outdir"/*.log 2>/dev/null | head -1)
          if [ -n "$log" ]; then
            split_log "$log" "$outdir/split"
            case "$s" in *COMPLETE*) st=COMPLETE;; *) st=ERROR;; esac
            diagnose "$outdir/split.out" "$outdir/split.err" "$id" "$st"
          fi
        else
          echo "FETCH_FAILED $id — rerun: kaggle kernels output $id -p $outdir"
        fi
        ;;
    esac
  done
  elapsed=$(( $(date +%s) - START ))
  if [ "$warned_stall" = 0 ] && [ "$elapsed" -gt $((STALL_H * 3600)) ] && [ "$PENDING" -gt 0 ]; then
    warned_stall=1
    echo "STALL_WARN ${STALL_H}h+ with $PENDING kernel(s) still RUNNING — check for hangs (heartbeats in $HEARTBEAT)"
  fi
  [ "$PENDING" -gt 0 ] && sleep "$POLL"
done
echo "WATCH_DONE all terminal"
