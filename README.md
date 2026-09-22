# Pulse

Pulse listens to a two-person sales conversation captured through two push-to-talk controls
— one for the dealer, one for the customer — and after every turn shows the estimated
probability that the deal will close, how that probability moved (momentum), the turns where
it moved sharply (turning points), and what the call would have looked like without any
chosen turn (counterfactual replay). When the call ends it summarises the turns that mattered.
Everything runs on the laptop; nothing is sent to a network service during a call.

[`SPEC.md`](SPEC.md) is the product and build specification.

## How it works

```
Browser (localhost)                        Python backend (FastAPI, one process)
  push-to-talk capture (MediaRecorder) ──▶   Whisper base.en (faster-whisper, local)
  transcript, SVG probability chart          MiniLM turn encoder (frozen, cached per turn)
  counterfactual, summary, replay     ◀──    causal scalar features F3–F8
                                             causal Transformer → temperature → p_t
                                             m_t = p_t − p_{t−1}; turning point if |m_t| ≥ τ
                                             counterfactual: same model, turn k masked
                                             session store: sessions/*.json
```

Per turn, transcription and encoding happen once and the turn vector is cached; the causal
model is then re-run over the cached vectors. Counterfactual replay hides turn k from
attention at every position and from every running feature — the same masking operation that
enforces causality — so the ghost path is a statement about the real model, not a surrogate.

## Requirements

* macOS on Apple silicon (developed on an M2 with 8 GB RAM), about 5 GB of free disk
* [`uv`](https://docs.astral.sh/uv/) — installs Python 3.12 and the pinned dependencies
* Node 20.19+ or 22.12+ for the interface
* Chrome or Safari; a USB desk microphone is recommended for a two-person demo

## One-time setup (needs the network)

```bash
uv sync                          # Python 3.12 environment from uv.lock
uv run pulse-fetch-models        # MiniLM encoder and Whisper base.en into the local cache
(cd web && npm ci && npm run build)
```

### Build the model

The pipeline follows SPEC §7.3. Each stage writes to `data/` (not committed) and reports to
`reports/`.

```bash
uv run pulse-acquire     # 1  Corpus A text columns only, via ranged Parquet reads (~75 MB)
uv run pulse-parse       # 2  one row per turn; exclusions counted by reason
uv run pulse-eda         # 3  EDA-01/02/03/04/06 and the decisions they gate
uv run pulse-split       # 4  dedupe; grouped by company, stratified; train/val_select/val_fit/test
uv run pulse-encode      # 6  MiniLM over every turn → float16 memory-map (~10 min on MPS)
uv run pulse-features    # 7  causal scalar features F3–F8
uv run pulse-train       # 9–11 train, select on val_select, calibrate and set τ on val_fit,
                         #      leakage suite, export artifacts/pulse_v1/
```

`artifacts/pulse_v1/` is the only thing the server loads: `model.pt`, `config.json`,
`scaler.json`, `calibration.json` (temperature), `thresholds.json` (τ and the base rate π̂)
and `metrics.json` (the validation results the artefact was selected on, including the
prefix-weighting sensitivity and the leakage-suite result).

The test partition is untouched by training. `uv run pulse-evaluate` evaluates the artefact on
it once and logs the run; a second evaluation is refused unless forced.

## Run Pulse (offline)

```bash
uv run pulse-serve               # http://127.0.0.1:8000
```

The server switches the model libraries to offline mode before loading anything, so it runs
with networking disabled. Options: `--asr small.en` (more accurate, slower), `--port`,
`--encoder-device cpu`, `--beam-size 1` (greedy decoding, slightly faster).

For interface development, run `npm run dev` in `web/` alongside the server and open
http://localhost:5173.

### During a call

* Hold **F** (dealer) or **J** (customer) while speaking; release to send the turn.
* Or type a turn, choose the speaker, and press **Enter** — same pipeline, no transcription.
* Select any past turn (transcript or chart) to replay the call without it; select it again
  or press **Esc** to return.
* **Undo last turn** after pressing the wrong key; **End call** for the summary, then save.
* **Replay** plays back saved sessions from their stored values — no microphone or model needed.
* Press **L** for the latency overlay.

### Replay sessions from the corpus

SPEC §9 asks for prepared sessions produced by real runs of the final artefact. This command
takes a real conversation from a validation partition and scores every turn through the live
path (as typed turns), then saves it to `sessions/`:

```bash
uv run pulse-import-session --pick closed
uv run pulse-import-session --pick lost
uv run pulse-import-session --pick recovery
```

Sessions saved from live calls appear in Replay alongside them.

## Tests

```bash
uv run pytest                    # leakage suite, features, API contract
(cd web && npm run typecheck && npm run lint && npm test)
```

The leakage suite (SPEC §7.4) also runs inside `pulse-train`; a failure blocks export.

## Repository layout

```
src/pulse/
  data/       acquire.py  parse.py  split.py
  eda/        phase0.py
  features/   encoder.py  scalars.py  build.py
  model/      causal_transformer.py  calibration.py  artifact.py  leakage.py
  train/      train.py
  eval/       evaluate.py
  serve/      app.py  asr.py  session.py  models.py  import_session.py
web/          React + Vite + TypeScript interface
tests/        test_leakage.py  test_api.py  test_features.py
sessions/     saved sessions for Replay
reports/      EDA, split, parse and training reports
artifacts/    exported model versions      (not committed)
data/         interim and processed data   (not committed)
```

## Data

Corpus A is [`DeepMostInnovations/saas-sales-conversations`](https://huggingface.co/datasets/DeepMostInnovations/saas-sales-conversations)
(Apache 2.0). Only `conversation_id`, `company_id`, `conversation`, `outcome` and
`conversation_length` are read; the precomputed embeddings, `probability_trajectory`,
`customer_engagement`, `sales_effectiveness` and `full_text` are never downloaded.
