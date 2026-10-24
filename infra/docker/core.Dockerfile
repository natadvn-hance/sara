# whisper.cpp for Boris's voice messages, built from a pinned tag. The deploy builds on the server itself,
# so the CPU-specific build (GGML_NATIVE) matches the machine it runs on.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.9.4
# ON tunes the build to the building machine's CPU (the server); OFF builds anywhere (a check on a Mac).
ARG GGML_NATIVE=ON
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp /src \
  && cmake -S /src -B /build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=${GGML_NATIVE} \
  && cmake --build /build --config Release -j --target whisper-cli

# Core image: Node 24, the pinned Claude Code CLI and the TypeScript sources run with tsx.
FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.308
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli
RUN corepack enable && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV SARA_ROLES_DIR=/app/roles SARA_DATA_DIR=/data
VOLUME ["/data"]
# node runs directly (not under pnpm), so SIGTERM reaches it and the core stops cleanly.
CMD ["node", "--import", "tsx", "apps/core/src/main.ts"]
