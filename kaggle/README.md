# Qwen3.8-27B on Kaggle (free GPU)

Serves `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF` (IQ3_S, ~12 GB) behind an
OpenAI-compatible API, as a fast alternative to the NIM free tier for the
support-compressor evals. Stack: llama-cpp-python server (CUDA) +
Cloudflare quick tunnel. No auth on the server; the tunnel URL is an
unguessable capability — treat it like a password.

## One-time setup (Kaggle UI)

1. Upload `qwen3_8_27b_server.ipynb` (or New Notebook → paste the cells).
2. Right sidebar → Accelerator: **GPU T4 x2**. Internet: **ON**.
3. Run all. Takes ~15 min (pip + 12 GB download + model load).
4. The tunnel cell prints `PUBLIC URL: https://....trycloudflare.com`.

Keep the notebook running while you use it (free sessions cap at ~9–12 h;
GPU quota is 30 h/week). Re-running costs ~15 min. The URL dies with the
kernel — every fresh run prints a new one.

## Worker wiring (no code changes)

The worker's OpenAI client already takes any base URL. The eval runner
reads one env var:

```sh
export QWEN_BASE_URL=https://....trycloudflare.com/v1   # note /v1 suffix
node --experimental-strip-types scripts/nim-expand.ts --resume
```

With `QWEN_BASE_URL` set, the runner targets Qwen (model label
`Qwen/Qwen3.8-27B`, no API key — the URL is the credential) and writes
`qwen-expand.*` files so Qwen evidence never mixes with NIM evidence.
Without it, everything behaves exactly as before (DeepSeek via NIM).

Security posture, stated plainly: requests AND replies pass through
Cloudflare's tunnel network in cleartext to Cloudflare (TLS ends at
their edge on our side only in the quick-tunnel case — assume readable
in transit). Eval-only: never send production user data. Never commit
a tunnel URL (it also expires with the kernel anyway).

## Performance notes

- Expect ~20–40 tok/s (bandwidth-bound on T4) — seconds per eval call
  vs the NIM free tier's minutes. First call is slowest (cold GPU).
- Context is 8192 (our prompts run ≤1500 tokens; plenty of headroom).
- IQ3_S is the quality floor of this setup, not the ceiling (below).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No GPU visible` | Enable GPU T4 x2 in notebook settings, re-run. |
| CUDA OOM in server log | `N_CTX` → 4096, then `N_GPU_LAYERS` → 40, re-run launch cell. |
| pip CUDA wheel import fails | Retry with the cu121 index (`.../whl/cu121`), or CPU wheel (slow). |
| No tunnel URL in log | Wait 60 s, re-check `/tmp/cloudflared.log`; re-run the cell. |
| Smoke asserts empty reply | Model misbehaving — check `/tmp/llama-server.log`. |

## Alternatives (one-variable changes)

- Better quality: unsloth `Qwen3.8-27B-GGUF` Q4_K_M (~16.5 GB) — swap
  `REPO`/`GGUF_FILE`, needs full T4 x2 headroom or partial offload.
- Faster: same repo, `IQ2_XS` file (~8 GB) — more degradation.
- vLLM instead of llama-server: needs T4 x2 + AWQ (community quants
  exist but are random third-party uploads — vet before trusting).
- Speculative decoding (`-mtp` files): skipped — extra flags, unproven.

## Verification limits (honest)

This setup was NOT run end-to-end from here (no Kaggle credentials in
this environment, and a GPU run needs a phone-verified account). What
was verified: notebook JSON validity + schema, every code cell compiles,
pip/URL/flag names reviewed against upstream docs, worker client proven
against two live OpenAI-compatible servers already. The notebook itself
is self-verifying: GPU assert, import assert, health wait, smoke asserts,
tunnel-URL assert — the first silent failure mode is a loud cell error.
