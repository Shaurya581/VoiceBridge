# VoiceBridge

VoiceBridge is a student MVP foundation for spoken frontline incident reporting. Its backend is a modular Express application with PostgreSQL/Prisma and a background deadline worker. This is an academic simulation, not a certified industrial safety or emergency response system.

## Current status

### Implemented

- React/TypeScript dashboard, authenticated API, role checks, incident/task routes, and audit history.
- Voice report persistence for Hindi, Hinglish, and Tamil selections, with transcript, original audio reference, confidence, audio-quality label, and extracted JSON fields.
- Deterministic safety keyword check before assignment workflow, with English, Hindi, Hinglish, and Tamil terms. Emergency reports are marked critical, create a timed emergency event, receive immediate mock spoken acknowledgement and mock alert, and skip normal reminder/escalation processing.
- Duplicate foundations: high-confidence same-asset/issue matches attach a report to an existing incident; uncertain matches are recorded for manager review. Original recordings/reports remain preserved.
- Assignee completion creates a reporter-verification request. Only the original reporter can confirm or reject; confirmation closes the incident and rejection reopens it.
- Provider interfaces for speech-to-text, extraction, audio preprocessing, notifications, text-to-speech, IVR, and emergency alerts.
- Confidence retry response and pass-through audio-preprocessor boundary. No actual VAD or noise suppression is claimed.
- Configurable IndicWhisper HTTP provider adapter (`STT_PROVIDER=indicwhisper`) and optional local Transformers server; confidence stays unknown unless that endpoint returns a score. Model weights and ML dependencies are not bundled.
- STT evaluation utility that reports corpus WER/CER by Hindi, Hinglish, Tamil, and clean/noisy group. It evaluates supplied references and hypotheses; it does not create benchmark results by itself.

### Mocked

- Speech recognition defaults to a mock. OpenAI Whisper is an optional adapter; IndicWhisper is an optional adapter to a configured endpoint. Neither provider has been run against this project's recordings or measured against the proposal targets.
- Extraction defaults to deterministic mock rules. Optional OpenAI and local Ollama structured-output adapters are available; both outputs pass backend Zod validation and deterministic safety/confirmation rules before workflow code can act.
- TTS, IVR calls, and emergency alerts are mock providers that log simulated actions. `MOCK_IVR_RESPONSE=1` or `2` can simulate a closure response; leave it blank to collect a reporter response through the API.
- Email defaults to recorded mock delivery.

### Planned / not yet verified

- Downloading/configuring IndicWhisper model checkpoints and verifying real inference, Hindi/Tamil TTS, a real telephony provider, VAD/noise suppression, labeled multilingual/noisy evaluation data, and measured quality/latency results.
- The proposal’s evaluation targets are goals to measure, not achieved results.
- The current browser speech API and mock providers do not establish production-grade multilingual speech recognition.
- Local Ollama extraction requires a separately installed Ollama runtime/model; no LLM weights are bundled or downloaded.
- The Ollama extraction adapter has not been run against a model or measured on held-out multilingual transcripts.

## Local development

The repository declares pnpm 11.19.0. With that package manager available, install dependencies and create a local environment file:

```sh
pnpm install
cp .env.example .env
```

Set `DATABASE_URL`, then generate the Prisma client and apply migrations with a local PostgreSQL instance:

```sh
pnpm db:generate
pnpm db:migrate
pnpm --filter @voicebridge/api seed
pnpm dev
```

Docker Compose configuration is provided, but Docker/database startup has not been verified in the current environment. Direct provider integrations require their corresponding credentials and are outside the all-mock default.

To run the included local wrapper, follow [`apps/api/indicwhisper/README.md`](apps/api/indicwhisper/README.md). Then set `STT_PROVIDER=indicwhisper` and `INDICWHISPER_ENDPOINT=http://127.0.0.1:8010/transcribe`. The wrapper expects local Hindi and Tamil checkpoints configured separately; Hinglish uses the Hindi checkpoint. The endpoint returns JSON `{ "text": "...", "language": "hi" }`; confidence remains unknown because IndicWhisper's documented inference returns text without a calibrated confidence score. AI4Bharat documents model downloads and Transformers inference in its [Vistaar repository](https://github.com/AI4Bharat/vistaar#inference-using-indicwhisper), not an HTTP contract, so this project includes a thin local wrapper. Keep it bound to localhost unless you configure its API key.

For optional local structured extraction, set `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL` in `.env` and run Ollama separately. The backend sends the extraction schema as a structured-output constraint and validates the returned JSON again before use. No Ollama runtime or model is included or installed by this project. When the transcript has no clear deadline, team, or requested action, those fields require reporter confirmation before workflow creation.

## Verification commands

```sh
pnpm typecheck
pnpm build
pnpm test
```

STT result evaluation accepts JSON Lines containing one sample per line:

```json
{"language":"hi","audioQuality":"clean","reference":"...","hypothesis":"..."}
```

Include `hinglish`/`ta` and `noisy` samples as appropriate, then run `pnpm --filter @voicebridge/api eval:stt path/to/samples.jsonl`. Use a representative, consented, labeled dataset; do not put private worker recordings in the repository. These metrics apply only to supplied samples and do not establish proposal target attainment.

The API health endpoint is `/api/health`. Workflow endpoints are under `/api`; reporter closure responses use `POST /api/incidents/:id/verify-closure` with response `1` (fixed) or `2` (still present). Managers can record an emergency response through `POST /api/incidents/:id/emergency-response` and inspect or resolve duplicate reviews through `/api/duplicate-reviews`.
