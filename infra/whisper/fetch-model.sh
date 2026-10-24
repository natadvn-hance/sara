#!/usr/bin/env bash
# Puts the whisper.cpp model for Boris's voice messages into the core's data volume, once.
# Run on the server: bash infra/whisper/fetch-model.sh   (about 466 MB, checked by its sha256)
set -euo pipefail
cd "$(dirname "$0")/../.."
MODEL=ggml-small.bin
# sha256 of ggml-small.bin as published in huggingface.co/ggerganov/whisper.cpp.
SHA=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b
COMPOSE="docker compose -f infra/compose.prod.yml --env-file .env"
if $COMPOSE exec -T core sh -c "test -s /data/whisper/$MODEL && echo $SHA /data/whisper/$MODEL | sha256sum -c --status"; then
  echo "Модель уже на месте"
  exit 0
fi
$COMPOSE exec -T core sh -c "mkdir -p /data/whisper && cd /data/whisper \
  && node -e \"fetch('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL').then(async r => { if (!r.ok) throw new Error(r.status); require('fs').writeFileSync('$MODEL.part', Buffer.from(await r.arrayBuffer())) })\" \
  && echo '$SHA  $MODEL.part' | sha256sum -c - && mv $MODEL.part $MODEL"
echo "Модель распознавания голоса загружена"
