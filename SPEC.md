# Pulse — Product & Build Specification

*Version 2 · supersedes `LiveDeal_Project_Pitch.md` · 22 September 2026*
*Team: Jeya Viknan, Cavin · Guide: Dr. Pattabiraman V.*

This document specifies the product that will be built and demonstrated. It is the
single reference for implementation. It is bound by Report Sections 1–8 as frozen:
**nothing is demonstrated that the report does not define, and nothing the report
commits to is omitted.** Where this spec refines a report commitment, the refinement
is flagged `[REPORT-SYNC]` and the report must be updated to match.

Verification markers carried over from the report: **✓** confirmed · **⚠** must be
measured or verified before depending on it.

---

## 1. Product in one paragraph

Pulse is a local, single-laptop application that listens to a two-person sales
conversation captured through two push-to-talk buttons — one for the dealer, one for
the customer — and after every turn displays the estimated probability that the deal
will close. It shows how that probability moved (momentum), marks the turns where it
moved sharply (turning points), and lets the presenter click any past turn to re-run
the conversation with that turn removed (counterfactual replay). When the call ends it
produces a summary of the turns that mattered. Everything runs on-device; nothing is
sent to a network service.

**Analytics type (Module 1):** predictive, with a diagnostic layer. Explicitly not
prescriptive — Pulse never suggests what to say.

---

## 2. Scope

### 2.1 In scope — the demo will show exactly these

| ID | Feature | Report basis |
|---|---|---|
| **P1** | Two-channel push-to-talk capture (Dealer / Customer) | A3, O5 |
| **P2** | Live speaker-tagged transcript | O5, D4 |
| **P3** | Live probability path p_t with base-rate reference line | R1, R2, O1, O2 |
| **P4** | Momentum m_t per turn and automatic turning-point markers | §1.4, O3 |
| **P5** | Counterfactual replay: click a past turn → ghost path with that turn masked | R3, O4 |
| **P6** | End-of-call summary card | D4 |
| **P7** | Session save and Replay Mode | D5 |
| **P8** | Typed-turn fallback (enter a turn as text instead of speaking) | Demo safety — see §9 |
| **P9** | Developer latency overlay (per-stage timings, hidden by default) | O5 measurement |

### 2.2 Explicitly out of scope — the demo will not show these

| Excluded | Why |
|---|---|
| Forecast cone / quantile head / predictive intervals | Not in §1.4, no objective covers it (§6.9). **The old Canva deck still shows this — do not present it.** |
| Next-utterance suggestions or coaching | N2 — diagnostic, not prescriptive |
| Word-level colour highlighting | Cut during design (§5, earlier drafts) |
| Speaker diarisation | N4 — solved by construction via push-to-talk |
| Prosody / audio-derived features | §5.5 — neither corpus contains audio |
| Multiple concurrent sessions, cloud, telephony | N5 |
| Non-English or degraded audio | N6 |

---

## 3. Demo environment

| Item | Value |
|---|---|
| Machine | Apple M2, **8 GB RAM**, macOS ✓ |
| Free disk | 65 GB ✓ |
| Python | **3.12, pinned via `uv`** — the system Python (3.14) is ahead of parts of the ML stack ⚠ |
| Network | **Not required during the demo.** All models downloaded and cached in advance |
| Microphone | One shared microphone. A USB desk mic is strongly preferred over the laptop mic for a two-person demo |
| Display | Laptop screen mirrored to projector; UI must remain legible at 1280 × 720 |
| Browser | Chrome or Safari, localhost only |

**The 8 GB constraint governs three decisions:** the dataset is read column-selectively
and never loaded whole (§7.1); the Whisper model is limited to `base.en` or `small.en`;
turn embeddings are stored as a float16 memory-map rather than held in RAM.

---

## 4. The user experience

### 4.1 Screen layout

One screen, three regions. Nothing else is visible during a live call.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PULSE                                  ● Live   Replay   [Summary]  │
├───────────────────────────────┬──────────────────────────────────────┤
│                               │                                      │
│   TRANSCRIPT                  │   PROBABILITY PATH                   │
│                               │                                      │
│   D  Hi, thanks for taking…   │   1.0 ┤                              │
│   C  Sure. What does it cost? │       │        ●                     │
│   D  Plans start at…          │   0.5 ┤ ─ ─ ● ─ ─ ─ ─ ─ ─ base rate  │
│   C  That's more than we…  ◆  │       │          ╲                   │
│   D  I understand. What if…   │   0.0 ┤           ◆──●               │
│                               │        1   2   3   4   5   turn      │
│   (click a turn to replay     │                                      │
│    without it)                │   Turn 4  m = −0.21  turning point   │
├───────────────────────────────┴──────────────────────────────────────┤
│        [ HOLD  F — DEALER ]            [ HOLD  J — CUSTOMER ]        │
│        or type a turn: [__________________________]  [Dealer|Cust]   │
└──────────────────────────────────────────────────────────────────────┘
```

- **◆** marks a turning point (|m_t| ≥ τ), both in the transcript and on the chart.
- The dashed horizontal line is the base rate π̂ — the anchor p_0 for momentum.
- A hover or tap on any chart point shows t, p_t, m_t.

### 4.2 Interaction model

| Action | Result |
|---|---|
| Hold **F** or the Dealer button | Recording indicator on Dealer; audio captured |
| Release | Audio sent; transcript line appears; p_t, m_t appear; chart extends by one point |
| Hold **J** or the Customer button | Same, tagged Customer |
| Type a turn and press Enter | Identical pipeline, skipping transcription |
| Click a past transcript line or chart point | Counterfactual replay: ghost path drawn with that turn masked; Δ shown |
| Click the same turn again, or Esc | Ghost path dismissed |
| **End Call** | Summary card opens; session can be saved |
| **Replay** | Load a saved session and step through it at a chosen speed |

Only one button records at a time. A press on the second button while the first is held
is ignored, not queued.

### 4.3 States

```
Idle ──hold──▶ Listening ──release──▶ Transcribing ──▶ Updating ──▶ Idle
 │                                                                   ▲
 ├──click past turn──▶ Replaying ──dismiss────────────────────────────┤
 └──End Call─────────▶ Summary ──new call──▶ Idle
```

While in **Transcribing** or **Updating**, new presses are blocked and the buttons show
a busy state. This prevents two turns racing each other.

### 4.4 Summary card (P6)

Built only from quantities already computed live — no new model call.

- Final p_T and the base rate it started from
- Total movement p_T − π̂, with the note that it decomposes exactly across turns
- The three largest |m_t| turns, quoted, signed
- Dealer share of turns and of words
- Number of turning points detected

### 4.5 Visual language

Reuses the Review 1 deck identity so the demo and the slides read as one product:
Kraft brick primary, warm neutral ground, one alert colour for negative movement, one
positive colour for upward movement. The ghost path is the primary colour at reduced
opacity with a dashed stroke.

---

## 5. System architecture

### 5.1 Components

```
 Browser (localhost)                         Python backend (FastAPI)
 ┌─────────────────────────┐   WebSocket    ┌────────────────────────────────┐
 │ Push-to-talk capture    │ ─────────────▶ │ Session manager                 │
 │ (MediaRecorder, 16 kHz) │                │   ├─ ASR  (Whisper, local)      │
 │ Transcript view         │ ◀───────────── │   ├─ Turn encoder (MiniLM)      │
 │ Probability chart (SVG) │                │   ├─ Scalar features (causal)   │
 │ Summary card            │   REST         │   ├─ Causal Transformer         │
 │ Replay controls         │ ◀────────────▶ │   ├─ Calibration (temperature)  │
 └─────────────────────────┘                │   └─ Momentum / turning points  │
                                            │ Counterfactual engine           │
                                            │ Session store (JSON on disk)    │
                                            └────────────────────────────────┘
```

Speaker separation happens **in the browser**: the button that was held determines the
speaker tag. The audio itself carries no speaker information and none is inferred.

### 5.2 Per-turn processing path

| Step | Stage | Notes |
|---|---|---|
| 1 | Audio capture | Browser, mono, 16 kHz |
| 2 | Transcription | Whisper, local, English-only model |
| 3 | Turn encoding | MiniLM → 384-d vector, computed **once** and cached for the session |
| 4 | Scalar features | Updated from running session state — counts and shares |
| 5 | Sequence model | Causal Transformer over the cached turn vectors |
| 6 | Calibration | Divide logit by fitted temperature, sigmoid → p_t |
| 7 | Derived | m_t = p_t − p_{t−1}; turning point if \|m_t\| ≥ τ |
| 8 | Emit | Transcript + estimate + stage timings to the browser |

**On incremental inference `[REPORT-SYNC]`.** The expensive per-turn work — transcription
and turn encoding — is done exactly once per turn and cached. The sequence model is then
re-run over the cached turn vectors. At dialogue lengths of 10–30 turns and roughly 1M
parameters this costs a few milliseconds and is simpler and less error-prone than a
key/value cache. Report O5 currently promises "amortised O(1) per turn … not
re-processing of the full prefix." **Either** the report wording is refined to "turn
encoding is O(1) per turn and cached; the sequence model re-evaluates cached vectors,"
**or** a KV cache is implemented as a stretch item (M5). Decide before Review 2.

### 5.3 Counterfactual replay path

1. Browser sends the session id and the turn index k to mask.
2. Backend re-runs the sequence model over the same cached vectors with turn k removed
   from the attention mask for every position.
3. Returns the full ghost path p′_1 … p′_T and δ_k = p_T − p′_T.
4. No transcription or encoding is repeated.

Removing a turn is the same operation as enforcing causality — a mask change — so the
replay is a statement about the real model, not a surrogate. Replays are computed on
demand only, never automatically after each turn.

### 5.4 Interface contract

**WebSocket `/ws/session/{id}`** — client → server

| Message | Payload |
|---|---|
| `turn_audio` | `{speaker: "dealer"\|"customer", audio: <binary webm/wav>}` |
| `turn_text` | `{speaker, text}` |
| `end_call` | `{}` |

**WebSocket** — server → client

| Message | Payload |
|---|---|
| `status` | `{state: "transcribing"\|"updating"\|"idle"}` |
| `turn` | `{t, speaker, text}` |
| `estimate` | `{t, p, m, turning_point: bool, timings_ms: {asr, encode, model, total}}` |
| `error` | `{stage, message}` — shown to presenter, session continues |

**REST**

| Endpoint | Purpose |
|---|---|
| `POST /session` | Create a session → `{id, base_rate, tau}` |
| `POST /session/{id}/counterfactual` | Body `{mask: [k]}` → `{path: [...], delta_T}` |
| `GET /session/{id}/summary` | Summary card data |
| `POST /session/{id}/save` | Persist to `sessions/` as JSON |
| `GET /sessions` · `GET /sessions/{name}` | List and load saved sessions for Replay |
| `GET /health` | Models loaded, artefact version |

### 5.5 Session file format

A saved session contains, per turn: speaker, text, p_t, m_t, turning-point flag and
stage timings; plus the artefact version it was produced with. **Audio is not saved by
default.** A replayed session re-renders from the stored values and does not re-run
transcription, so replay works with no microphone at all.

---

## 6. The model

### 6.1 The stack

| Stage | Component | Trained? |
|---|---|---|
| Turn encoder | `sentence-transformers/all-MiniLM-L6-v2` — 384-d | **No — frozen** |
| Sequence model | Custom causal Transformer encoder, from scratch | Yes |
| Head | Linear → 1 logit per turn position | Yes |
| Calibration | Temperature scaling, fitted post hoc on `val-fit` | Fitted after training |

### 6.2 Input per turn

| Block | Size | Features (Report §5) |
|---|---|---|
| Semantic | 384 | F1 turn embedding |
| Role | learned embedding, ~16 | F2 speaker role |
| Scalar | ~6–8 values, projected to ~16 | F3 turn index (bucketed), F4 prefix aggregates, F5 turn length, F6 interrogativity, F7 drift from running mean, F8 alternation *(conditional on EDA-06)* |

Concatenated and projected to `d_model`. Positional information uses the **absolute**
turn index t. **Never** t/T, total length, or any whole-conversation field (§3.2.5).

### 6.3 Indicative configuration

To be fixed on validation, not asserted: 2–4 layers, 4 heads, `d_model` 128–192,
dropout, lower-triangular causal mask, roughly 0.5–2M trainable parameters.

### 6.4 Training

- **Supervision:** terminal outcome Y only, applied to every prefix. The shipped
  `probability_trajectory` field is never read by the training pipeline.
- **Loss:** binary cross-entropy summed over positions; prefix weighting is a tuned
  hyperparameter with sensitivity reported (§6.5).
- **Batching:** by conversation.
- **Selection / early stopping:** early-regime discrimination on `val-select` — not
  terminal accuracy (§6.7).
- **Device:** Apple MPS where supported, CPU fallback.

### 6.5 Serving artefact

Training produces one directory, which is the only thing the backend loads:

```
artifacts/pulse_v1/
  model.pt            sequence model + head weights
  config.json         architecture, encoder name, feature list, version
  scaler.json         scalar-feature statistics — fitted on train only
  calibration.json    temperature
  thresholds.json     tau (turning points), base_rate (π̂)
  metrics.json        validation results the artefact was selected on
```

---

## 7. Data and training pipeline

### 7.1 Corpus A — acquisition under 8 GB RAM

`DeepMostInnovations/saas-sales-conversations` ✓ — 100,000 rows, 3,088 columns, 7.17 GB,
Apache 2.0, single `train` split.

- **Read only:** `conversation_id`, `company_id`, `conversation`, `outcome`, and
  `conversation_length` (stratification and EDA only — never a feature).
- **Never read:** the 3,072 `embedding_*` columns, `probability_trajectory`,
  `customer_engagement`, `sales_effectiveness`, `full_text`.
- **Method:** column-selective Parquet reads, shard by shard, written to a compact local
  file. If remote column selection is unavailable, download shards and select locally —
  the 65 GB of free disk accommodates this; RAM does not accommodate loading them whole.
- ⚠ **Verify first:** the storage format, and the exact JSON shape of `conversation`
  (field names for speaker and text, speaker labels used).

### 7.2 Corpus B — evaluation only

`stanfordnlp/craigslist_bargains` ✓ — 6,682 dialogues. Never trained on, never tuned
against (§4.1.2). Outcome derived by the rule fixed in EDA-21 *before* any evaluation;
fallback routes per §3.3.4.

### 7.3 Pipeline stages

| # | Stage | Output | Gate |
|---|---|---|---|
| 1 | Acquire text columns | `data/interim/corpus_a.parquet` | Row count = 100,000 |
| 2 | Parse turns | one row per (conversation, turn): speaker, text | Parse failures counted and reported |
| 3 | Phase 0 EDA | class balance, length, duplicates, grouping | EDA-01 to EDA-04 |
| 4 | Deduplicate + split | train / val-select / val-fit / test ids | Stratified; grouped if EDA-04 requires |
| 5 | Gating diagnostics | first-turn and positional separability | **EDA-09, EDA-10 decision rules** |
| 6 | Encode turns | float16 memmap + index | Run once, cached |
| 7 | Scalar features | causal per-turn features | Scaler fitted on train only |
| 8 | Baselines | B0–B7 | Label-permutation control passes |
| 9 | Train model | checkpoints | Leakage suite passes |
| 10 | Calibrate + τ | temperature, τ, π̂ | On `val-fit` only |
| 11 | Export | `artifacts/pulse_v1/` | Loads in the backend |
| 12 | Evaluate | Corpus A test, Corpus B | Test consumed once, logged |

**Embedding storage estimate:** ~100,000 conversations × ~15 turns ⚠ × 384 × 2 bytes ≈
1.1 GB on disk as a float16 memory-map. Encoding time on the M2 is estimated at tens of
minutes ⚠ and is done once.

### 7.4 Leakage test suite — a unit test, not a report claim

`tests/test_leakage.py`:

1. For sampled conversations and positions t, replace every turn after t with turns
   from an unrelated conversation. Assert p_t is unchanged to numerical tolerance.
2. Assert the training data loader never exposes `probability_trajectory`,
   `conversation_length`, `customer_engagement`, `sales_effectiveness` or `full_text`
   to the model's inputs.
3. Assert no conversation id appears in more than one partition.

These run on every model build. A failure blocks export.

---

## 8. Technology choices

| Layer | Choice | Reason |
|---|---|---|
| Environment | `uv`, Python 3.12 | Reproducible; avoids 3.14 incompatibilities |
| Deep learning | PyTorch (MPS) | Causal mask and masking-based replay are direct |
| Turn encoder | `sentence-transformers` | Standard MiniLM loader |
| ASR | `faster-whisper` default; `mlx-whisper` benchmarked | Portable default; MLX may be faster on M2 — choose by measurement in M0 |
| Baselines | scikit-learn, LightGBM | B2–B4 |
| Data | pyarrow, pandas | Column-selective Parquet |
| Backend | FastAPI + uvicorn | WebSocket + REST in one process |
| Frontend | React + Vite + TypeScript, custom SVG chart | Full control of ghost path and markers |
| Tests | pytest | Leakage suite, API contract |

---

## 9. Demo safety

A live demo in front of a panel fails in predictable ways. Each has a designed response.

| Failure | Response |
|---|---|
| Microphone fails or room is noisy | **P8 typed-turn fallback** — same pipeline, no transcription |
| Anything fails live | **P7 Replay Mode** with pre-saved sessions |
| Network unavailable | Nothing to do — Pulse is fully offline |
| Wrong button pressed | Delete-last-turn control; re-speak |
| Transcription mishears a key word | Presenter can edit the turn text before it is scored — optional toggle, off by default |
| Laptop under memory pressure | Close other apps; Whisper `base.en` rather than `small.en` |

**Prepared sessions:** three conversations — one that closes, one that is lost, one that
recovers from an objection — each saved from a real run of the final artefact, not
hand-authored values.

---

## 10. The demo script

Target: 90 seconds live, inside slide 13's slot.

| Beat | Presenter action | What the panel sees |
|---|---|---|
| 1 | Open Pulse, new call | Empty transcript, flat base-rate line |
| 2 | Hold F: dealer opening line | Transcript line; first point near the base rate |
| 3 | Hold J: customer shows interest | Point rises |
| 4 | Hold J: price objection | Sharp drop; ◆ turning point appears on the turn and the chart |
| 5 | Hold F: dealer addresses objection | Partial recovery |
| 6 | Click the objection turn | Ghost path appears, higher — the same call without that turn |
| 7 | Click again | Ghost dismissed |
| 8 | End Call | Summary card: biggest turns, talk share, total movement |

**Line to say at beat 6:** "This isn't a lookup. It's the same model, re-run with that
turn masked out."

---

## 11. Build milestones

Aligned to the Review 1 timeline phases. Each has an exit criterion.

| Milestone | Phase | Deliverable | Exit criterion |
|---|---|---|---|
| **M0** | Dataset audit | Environment, data acquisition, parse, ASR benchmark | Corpus A text columns on disk; `conversation` schema confirmed; ASR backend chosen by measured latency |
| **M1** | Dataset audit | Phase 0 EDA + gating diagnostics | EDA-01–04, 09, 10, 12, 21 run; decisions recorded against their pre-registered rules |
| **M2** | Baselines & features | Splits, turn encodings, scalar features, B0–B7 | Baseline table produced; label-permutation control passes |
| **M3** | Model development | Causal Transformer, calibration, τ, artefact export | Leakage suite green; artefact loads |
| **M4** | Live integration | Backend, frontend, push-to-talk, replay, summary, typed fallback | Full demo script runs end to end offline |
| **M5** | Hardening | Latency measurement, prepared sessions, *(stretch: KV cache)* | Per-stage latency recorded on the demo machine |
| **M6** | Evaluation & reporting | Corpus A test, Corpus B transfer, results-vs-objectives table | Every O1–O7 adjudicated met or not met |

**Build the demo shell early.** M4 can begin on a stub model that returns the base rate,
so the interface is ready before the real artefact exists. The real artefact then drops
in through the §6.5 contract with no interface change.

---

## 12. Repository layout

```
pulse/
  SPEC.md
  pyproject.toml
  src/pulse/
    data/        acquire.py  parse.py  split.py
    eda/         phase0.py  gating.py
    features/    encoder.py  scalars.py
    model/       causal_transformer.py  calibration.py
    train/       train.py  baselines.py
    eval/        metrics.py  transfer.py
    serve/       app.py  asr.py  session.py  counterfactual.py
  web/           React + Vite frontend
  tests/         test_leakage.py  test_api.py  test_features.py
  artifacts/     exported model versions          (not committed)
  data/          raw / interim / processed        (not committed)
  sessions/      saved demo sessions
  reports/       EDA outputs and figures
```

---

## 13. Acceptance criteria

| Feature | Accepted when |
|---|---|
| P1 | Holding either control records only that speaker; releasing produces exactly one turn |
| P2 | Every turn appears with the correct speaker tag |
| P3 | A point appears after every turn; base-rate line equals `thresholds.json` |
| P4 | m_t shown for every t ≥ 1; markers appear exactly where \|m_t\| ≥ τ |
| P5 | Ghost path differs from the real path only at t ≥ k; dismiss restores the view |
| P6 | Summary values reconcile with the live values; Σ m_t equals p_T − π̂ |
| P7 | A saved session replays identically with the microphone disconnected |
| P8 | A typed turn produces the same estimate as the same text transcribed |
| P9 | Stage timings present on every estimate message |
| System | Runs with networking disabled; leakage suite green on the shipped artefact |

---

## 14. Open decisions

Defaults are chosen so work can start; each can be changed.

| # | Decision | Default | Decide by |
|---|---|---|---|
| 1 | ASR backend | `faster-whisper` `base.en` | M0 benchmark |
| 2 | Frontend framework | React + Vite | Start of M4 |
| 3 | Incremental inference wording vs KV cache `[REPORT-SYNC]` | Refine report wording | Before Review 2 |
| 4 | Push-to-talk keys | F = Dealer, J = Customer | Start of M4 |
| 5 | Microphone | USB desk mic | Before first rehearsal |
| 6 | Presenter transcript editing | Off | M5 rehearsal |

---

## 15. Principal risks

| Risk | Effect | Response |
|---|---|---|
| Corpus B outcome not derivable (DA3) | Transfer study weakened | Escalation routes §3.3.4; qualitative fallback |
| Generation priming confirmed (DA6) | Early-turn claims artefactual on Corpus A | Report as a primary finding |
| No order sensitivity (EDA-12) | Sequence model unjustified | Fall back to a per-turn classifier; the demo still runs |
| 8 GB RAM exhausted during data work | Pipeline crashes | Column-selective reads; memmap storage; shard processing |
| Whisper latency too high on M2 | Demo feels sluggish | `mlx-whisper`, smaller model, typed fallback |
| Live mishearing flips meaning | Embarrassing demo moment | Rehearsed script, USB mic, typed fallback, replay sessions |
