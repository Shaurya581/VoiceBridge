"""Optional local HTTP wrapper for AI4Bharat IndicWhisper checkpoints."""

from __future__ import annotations

import os
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

app = FastAPI(title="VoiceBridge local IndicWhisper adapter", docs_url=None, redoc_url=None)
MAX_AUDIO_BYTES = int(os.getenv("INDICWHISPER_MAX_AUDIO_BYTES", str(25 * 1024 * 1024)))
MIME_EXTENSIONS = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/aac": ".aac",
}
INFERENCE_LOCK = Lock()


def model_path_for(language: str) -> Path:
    variable = "INDICWHISPER_TA_MODEL" if language == "ta" else "INDICWHISPER_HI_MODEL"
    configured_path = os.getenv(variable)
    if not configured_path:
        raise HTTPException(status_code=503, detail=f"{variable} must point to a downloaded IndicWhisper checkpoint")
    model_path = Path(configured_path).expanduser().resolve()
    if not model_path.exists():
        raise HTTPException(status_code=503, detail=f"Configured checkpoint does not exist: {variable}")
    return model_path


def inference_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda:0"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@lru_cache(maxsize=2)
def load_pipeline(language: str) -> Any:
    from transformers import pipeline

    model = pipeline(
        "automatic-speech-recognition",
        model=str(model_path_for(language)),
        device=inference_device(),
    )
    model.model.config.forced_decoder_ids = model.tokenizer.get_decoder_prompt_ids(
        language=language,
        task="transcribe",
    )
    return model


def require_api_key(authorization: str | None) -> None:
    expected = os.getenv("INDICWHISPER_SERVER_API_KEY")
    if expected and authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid inference service credentials")


def run_inference(language: str, audio_path: str) -> dict[str, str]:
    model_language = "ta" if language == "ta" else "hi"
    with INFERENCE_LOCK:
        recognizer = load_pipeline(model_language)
        return recognizer(audio_path)


def validate_duration(audio_path: str) -> None:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audio_path],
            capture_output=True,
            check=True,
            text=True,
            timeout=10,
        )
        duration = float(probe.stdout.strip())
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail="Install ffmpeg (ffprobe) to validate recording duration") from error
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as error:
        raise HTTPException(status_code=415, detail="Audio duration could not be read") from error
    if duration <= 0 or duration > 30:
        raise HTTPException(status_code=413, detail="Recording must be 30 seconds or shorter")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": "lazy-loaded"}


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: str = Form(...),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    require_api_key(authorization)
    if language not in {"hi", "hinglish", "ta"}:
        raise HTTPException(status_code=422, detail="language must be hi, hinglish, or ta")
    mime_type = (audio.content_type or "").split(";", maxsplit=1)[0].lower()
    suffix = MIME_EXTENSIONS.get(mime_type)
    if not suffix:
        raise HTTPException(status_code=415, detail="Unsupported audio type")

    content = await audio.read(MAX_AUDIO_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio file exceeds the configured size limit")

    try:
        with tempfile.NamedTemporaryFile(prefix="voicebridge-", suffix=suffix) as recording:
            recording.write(content)
            recording.flush()
            validate_duration(recording.name)
            # Keep inference off the event loop and serialize it to avoid model-memory spikes.
            result = await run_in_threadpool(run_inference, language, recording.name)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=502, detail="Local IndicWhisper inference failed") from error

    transcript = result.get("text", "").strip()
    if not transcript:
        raise HTTPException(status_code=502, detail="IndicWhisper returned an empty transcript")
    # IndicWhisper's documented inference returns text; no calibrated confidence is inferred here.
    return JSONResponse({"text": transcript, "language": language})


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("INDICWHISPER_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "::1", "localhost"} and not os.getenv("INDICWHISPER_SERVER_API_KEY"):
        raise SystemExit("Set INDICWHISPER_SERVER_API_KEY before binding beyond localhost")
    uvicorn.run(app, host=host, port=int(os.getenv("INDICWHISPER_PORT", "8010")))
