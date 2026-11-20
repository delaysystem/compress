"""Kernel-side phone-home snippet (reference copy).

Copy this block to the TOP of each eval kernel's main cell, with KID set to
the kernel's short id. Repo files keep TUNNEL=""/TOKEN="" placeholders:
hb() no-ops until phonehome/push.sh stamps the live values into the pushed
copy, so unstamped kernels run exactly as before. push.sh refuses to push a
notebook that lacks the TUNNEL placeholder.

Reports: phases/progress via hb(), uncaught exceptions via a chained
sys.excepthook (posts 'fatal', then calls the previous hook). All posts are
best-effort: 5s timeout, exceptions swallowed, the eval never fails on
telemetry.
"""

import json as _json
import sys as _sys
import urllib.request as _urlreq

TUNNEL = ""  # stamped by phonehome/push.sh (public receiver URL); empty = disabled
TOKEN = ""  # stamped by phonehome/push.sh (bearer token); empty = disabled
KID = "EXAMPLE"  # per-kernel short id (cpu-shootout, cpu-lfm25, ...)


def hb(phase, msg=""):
    if not TUNNEL or not TOKEN:
        return
    try:
        body = _json.dumps(
            {"kernel": KID, "phase": phase, "msg": str(msg)[:300]}
        ).encode()
        req = _urlreq.Request(
            f"{TUNNEL}/hb?token={TOKEN}",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        with _urlreq.urlopen(req, timeout=5):
            pass
    except Exception:
        pass


_prev_hook = _sys.excepthook


def _hook(t, v, tb, _p=_prev_hook):
    hb("fatal", f"{t.__name__}: {v}")
    return _p(t, v, tb)


_sys.excepthook = _hook
print("phone-home:", "ON" if TUNNEL and TOKEN else "OFF (unstamped)")
