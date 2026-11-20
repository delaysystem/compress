# kaggle-cpu ops

CPU-only eval kernels (quota-free): model shootout + LFM2.5 speed test.
GPU notebooks live in `kaggle/`; the rules below apply to both.

## Mount path (verified 2026-11-12)

Datasets mount NESTED, not flat:

- WRONG: `/kaggle/input/<slug>/`
- RIGHT: `/kaggle/input/datasets/<owner>/<slug>/`

The flat path died silently between the GPU eval (worked) and the CPU
kernels (FileNotFound). A recursive `find /kaggle/input` in a probe kernel
is the decisive test whenever mounts are suspected.

## Watcher (errors within ~60s of terminal)

```bash
./watch.sh [--stall-hours N] <owner/slug> [<owner/slug> ...]
```

Polls status every 60s. On COMPLETE/ERROR it fetches the log, splits
stdout (runtime prints) from stderr (tracebacks) with jq, and prints:

- `reached:` — furthest progress marker (eval-set-ok, downloading,
  downloaded, server-ready, smoke, progress[N/45], done)
- `CAUSE:` — known-cause verdict + fix, or UNKNOWN + newest stderr lines

Heartbeats go to `/tmp/kwatch/watch.log` (silent). Stall warning after
8h (tunable). Offline test: `./watch.sh --diagnose-only <logfile> ...`

Known-cause catalog: missing server closure (`sse_starlette`), flat
dataset path, unmounted dataset, error-budget trip, server hang, OOM,
bad HF repo/filename. Add new patterns to `diagnose()` as failures teach
them — the catalog is the debugging investment.

## Notebook fail-fast rules (all eval kernels)

1. **Import-check the server chain BEFORE any heavy download.**
   `from llama_cpp.server.app import create_app` in the installer cell
   turns a post-download death into a minute-3 failure with a clear name.
2. **Install the server closure, not bare llama-cpp-python:**
   `llama-cpp-python[server]` + `sse-starlette starlette-context fastapi
   uvicorn[standard] pydantic pydantic-settings anyio httpx`.
3. **Print progress markers** (`eval set OK`, `downloading/downloaded`,
   `READY`, `smoke`, `N/45`, `done`) — the watcher reads them.
4. **On server death, print the server log tail + env capsule**
   (`free -g`, `df -h /tmp`) before raising.
5. **Flush output rows** (`out.flush()`) so partial results survive kills.

## Live phone-home telemetry (cloudflared)

`kaggle kernels output` is empty until terminal state, so kernels POST
heartbeats to a receiver here, exposed via a `cloudflared` quick tunnel.
Events land in `/tmp/kwatch/live.jsonl` seconds after they happen:
phase transitions, `progress[N/45]` rows, and `fatal` tracebacks (via a
chained `sys.excepthook`, so uncaught errors report before the kernel
dies). The 60s watcher stays as the backstop for kernels that die
without phoning home.

Files: `phonehome/server.py` (stdlib receiver, token-gated),
`phonehome/hb.py` (kernel snippet reference), `phonehome/push.sh`
(stamp + push wrapper).

Deploy (once per machine boot; survives session end via setsid):

```bash
export PHONEHOME_TOKEN_FILE=/tmp/phonehome/token PHONEHOME_PORT=8766
setsid -f python3 kaggle-cpu/phonehome/server.py </dev/null \
  >>/tmp/phonehome/receiver.log 2>&1
setsid -f /tmp/phonehome/bin/cloudflared tunnel \
  --url http://127.0.0.1:8766 </dev/null >>/tmp/phonehome/tunnel.log 2>&1
# then: save the trycloudflare URL from tunnel.log to /tmp/phonehome/url
```

Push a kernel WITH live telemetry: `phonehome/push.sh <kernel-dir>`
(stamps URL+token into a /tmp copy, validates, pushes; refuses when the
tunnel is down or the notebook lacks the helper). `--stamp-only` previews
without pushing. Repo files keep empty placeholders — no URL or token is
ever committed. The tunnel URL + token are bearer credentials: eval-only,
kept in /tmp, rotated by redeploying (stamped kernels keep working until
the tunnel restarts, then go silent but unaffected — telemetry never
fails an eval).

Live view: `tail -F /tmp/kwatch/live.jsonl`.
Restart: kill both setsid processes, redeploy, repush stamped kernels.
