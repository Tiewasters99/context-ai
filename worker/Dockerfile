# Always-on shared worker for Contextspaces (Discovery jobs + document
# ingestion). Built from the repo root:
#
#   docker build -f worker/Dockerfile -t contextspaces-worker .
#
# ffmpeg is required: .wma/.m4a evidence recordings transcode to mp3 before
# Gemini transcription.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only what the worker needs; the Vite front-end never builds here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY worker ./worker

# Env (set as host secrets, never baked in):
#   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (required)
#   OPENAI_API_KEY, GOOGLE_API_KEY                 (embeddings / OCR+transcribe)
#   WORKER_ID                                      (optional)
CMD ["node", "worker/discovery-worker.mjs"]
