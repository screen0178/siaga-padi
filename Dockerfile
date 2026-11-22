# SIAGA-Padi: one container = FastAPI (API + built web app) + scheduler.
# Build:  docker compose up -d --build      -> http://<server-ip>:8000

# 1) Web app (TypeScript -> web/dist)
FROM oven/bun:1.2-slim AS web
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
# Data is mounted at run time; keep it out of the bundle
RUN rm -rf public/data && bun run build

# 2) Python runtime: server + pipeline (the scheduler runs pipeline scripts)
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 SIAGA_DB=/app/var/siaga.db
WORKDIR /app
COPY pipeline/requirements.txt pipeline/requirements.txt
COPY server/requirements.txt server/requirements.txt
RUN pip install -r server/requirements.txt
COPY pipeline/ pipeline/
COPY server/ server/
COPY data/ data/
COPY web/public/data/ web/public/data/
COPY --from=web /app/web/dist web/dist
RUN mkdir -p var
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
# One worker only: the scheduler lives in the app process
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
