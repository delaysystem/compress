# `compress` — Art Direction & Design System (`DESIGN.md`)

## 1. Product Truth (Extracted from `/home/saul/Music/news`)

- **Product:** `compress` — LLM output compressor for customer support.
- **Core Mechanism:** Cut flagship API output tokens **~10×** (`8.83×` paired measured). The flagship model emits a compact, single-line space-separated **Wire v3 IR** using 46 verified 1-token UPPERCASE 2-letter separators (`AB`, `WA`, `MA`, `KA`, `AP`, `AD`, `TX`) instead of verbose prose. A local/edge 4-tier pipeline expands it back into a fluent customer reply.
- **Non-Negotiable Invariants:**
  1. **One flagship call per message, always** — zero flagship retries anywhere.
  2. **Tool calls pass through byte-exact.**
  3. **Validator-verified or explicit-loud:** 8 blocking checks (`validateExpansion`) → escalation ladder (`direct` | `SLM repair` | `deterministic template`). Never silently ship.
  4. **Billed tokens (prompt + completion + thinking)** is the deciding metric.
- **Verified Benchmarks (Run 035 & README):**
  - **Decompression Latency (n=100):** `0.41ms` p50 total (`199×` lower p50 than baseline `297.14ms → 1.49ms` on paired n=20).
  - **72% Deterministic Sub-ms Resolution:** Tier 1 `realizer.ts` resolves 72/100 replies with zero LLM calls (`parseDecodeMs: 0.19ms`, `fastPathMs: 0.27ms`).
  - **Quality & Reliability:** `100/100` end-to-end validator pass (`88/100` direct, `25/25` fresh-key holdout, `404/404` tests passing, `0` errors).
  - **Stack:** Cloudflare Workers (TypeScript), `llama.cpp`, finetuned `LiquidAI/LFM3-1.7B` (`red-ware/lfm3-expand-v13b`), latency-ranked multi-provider failover (`groq`, `anyapi`, `opentyphoon`, `openrouter`, `dreamprompting`), BSL 1.1 license.

---

## 2. Three Complementary Awwwards Directions

### Variant 01 — `concepts/01-monolith-singularity.html` (*"3D WebGL Token Singularity"*)
- **Reference:** `g-colombel-portfolio-2026` (SOTD + Dev Award) + `sweet-tape`.
- **Concept:** Compression as physical gravity. A glowing volcanic **3D WebGL Monolith & 900-Particle Token Vortex** (custom GLSL fBm plasma + Fresnel shader) orbits in an obsidian void (`#09080A`), physically collapsing a diffuse swarm of raw prose tokens into a razor-dense glowing Wire v3 core as you scroll.
- **Palette:** Obsidian Void `#09080A`, Ash Bone `#F2EFEA`, Volcanic Ember `#FF4B2B`.
- **Typography:** `Cormorant Garamond` (editorial display contrast) + `Space Grotesk` + `JetBrains Mono`.
- **Signature Interactions:** 3D WebGL collapsing particle swarm + plasma monolith synced to ScrollTrigger; interactive **Live Wire v3 Compressor/Decompressor** (click real support replies and watch 180 prose tokens collapse into a 19-token `AB / WA / TX` Wire v3 line and re-expand through the 4-tier ladder).

### Variant 02 — `concepts/02-swiss-barcode-press.html` (*"Obys Swiss Barcode & Compression Grid"*)
- **Reference:** `grids-1` (Obys Agency — SOTD + Dev Award) + `santal`.
- **Concept:** Compression expressed through pure Swiss graphic geometry. Features an iconic left-edge **animated vertical barcode compression spine** (echoing `GRIDS S03`), crisp bone parchment `#F4F3EE`, heavy jet-black `#0E0E0D` structural bars, cobalt-acid accent `#1D4ED8`, and a custom **2D GLSL Horizontal Scanline-Compaction Shader** that visibly squeezes raw prose columns into 1/10th width on scroll.
- **Typography:** `Syne` (800 display) + `Instrument Serif` (italic tension) + `IBM Plex Mono`.
- **Signature Interactions:** Scroll-scrubbed **10:1 Visual Column Compaction** (`100%` prose width physically compresses to `10%` Wire v3 strip), interactive **Wire v3 Grammar Tokenizer** (hover any 2-letter SEP code `AB`, `WA`, `MA`, `KA`, `TX` to inspect its slot arity & `{{Marker}}` restoration), and interactive **API Token Bill Forecaster**.

### Variant 03 — `concepts/03-optical-oscilloscope.html` (*"0.41ms Optical Telemetry Lab"*)
- **Reference:** `zirka-interceptor` + `deepbook` + `santal`.
- **Concept:** High-frequency engineering bench built around the **`0.41ms p50` (199× speedup)** breakthrough. Deep graphite `#0A0D10`, Phosphor Mint `#00E5A0`, Bone `#EDF1F2`, `Outfit` + `JetBrains Mono`.
- **Signature Interactions:** Real-time **3D WebGL Perspective Token-Stream Tunnel** (Three.js shader particles accelerating from slow amber prose streams into hyper-fast mint Wire v3 packets), interactive **4-Tier Decompression Pipeline Bench** (toggle Tier 0 O(1) Dict, Tier 1 Deterministic Realizer `0.27ms`, Tier 2 LRU Slot Cache, Tier 3 LFM3-1.7B / Failover Pool and watch the live latency histogram shift from `297.14ms` to `0.41ms`), and **8-Check Validator Escalation Ladder** inspector.
