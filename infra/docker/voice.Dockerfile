# syntax=docker/dockerfile:1.7
# Sara's voice (ADR-028): Silero v5_5_ru on the CPU, voice xenia. The model is baked in at build time and checked by
# its sha256, since the service runs on the internal network that has no way out. Silero's models are CC BY-NC:
# Boris knows it and chose the voice.
FROM python:3.12-slim
ARG TORCH_VERSION=2.15.0
RUN pip install --no-cache-dir "torch==${TORCH_VERSION}" --index-url https://download.pytorch.org/whl/cpu \
  && pip install --no-cache-dir numpy
# A file fetched by ADD is readable only by root: --chmod lets the service (nobody) read it.
ADD --chmod=644 --checksum=sha256:50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437 \
  https://models.silero.ai/models/tts/ru/v5_5_ru.pt /models/v5_5_ru.pt
COPY infra/voice/server.py /app/server.py
USER nobody
ENV PYTHONUNBUFFERED=1 VOICE_MODEL=/models/v5_5_ru.pt
EXPOSE 7080
CMD ["python", "-I", "/app/server.py"]
