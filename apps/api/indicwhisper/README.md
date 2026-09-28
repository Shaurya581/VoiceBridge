# Optional local IndicWhisper inference

This small HTTP wrapper loads AI4Bharat IndicWhisper checkpoints inside one Python process and exposes the endpoint consumed by VoiceBridge's existing API. The application backend remains the incident/workflow backend; the model process is an optional local inference runtime. No model files or recordings are committed.

## Requirements

- Python 3.10 or later. Python 3.12 is available in the Codex workspace runtime.
- `ffmpeg` on `PATH` for Transformers to decode browser WebM and other supported audio formats.
- A downloaded AI4Bharat IndicWhisper checkpoint for Hindi and another for Tamil. The model files can be large; download only the languages needed. Follow the [official Vistaar model and inference instructions](https://github.com/AI4Bharat/vistaar#inference-using-indicwhisper).
- Apple Silicon can use PyTorch MPS when available; the wrapper falls back to CUDA or CPU based on the installed runtime. Actual speed and memory use depend on the selected checkpoints.

## Setup

From the project root, create an isolated environment for the optional model server:

```sh
python3 -m venv apps/api/indicwhisper/.venv
apps/api/indicwhisper/.venv/bin/python -m pip install --upgrade pip
apps/api/indicwhisper/.venv/bin/python -m pip install -r apps/api/indicwhisper/requirements.txt
```

Download the Hindi and Tamil checkpoints using AI4Bharat's current instructions and point the variables to their extracted model directories:

```sh
export INDICWHISPER_HI_MODEL=/absolute/path/to/hindi/checkpoint
export INDICWHISPER_TA_MODEL=/absolute/path/to/tamil/checkpoint
apps/api/indicwhisper/.venv/bin/python apps/api/indicwhisper/server.py
```

The server binds to `127.0.0.1:8010` by default and loads each checkpoint lazily on its first request. For non-local binding, set `INDICWHISPER_SERVER_API_KEY` before setting `INDICWHISPER_HOST`; the VoiceBridge API must use the same value in `INDICWHISPER_API_KEY`. The handler accepts `audio` and `language` multipart fields, limits audio bodies to 25 MiB and recordings to 30 seconds, and serializes inference to avoid concurrent model memory spikes.

In the main VoiceBridge `.env`, set:

```sh
STT_PROVIDER=indicwhisper
INDICWHISPER_ENDPOINT=http://127.0.0.1:8010/transcribe
```

The first inference can take time while the model loads. This local wrapper does not implement VAD, denoising, or a confidence estimate. Keep the default mock provider for routine development until the checkpoints have been installed and tested on the target machine.
