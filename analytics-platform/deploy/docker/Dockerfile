# syntax=docker/dockerfile:1.7
#
# Analytics Platform backend image (API and job worker share one image).
#
# Build context is the backend directory:
#   docker build -f analytics-platform/deploy/docker/Dockerfile \
#     -t analytics-platform:dev analytics-platform/backend
#
# API (default):  uvicorn app.main:app --host 0.0.0.0 --port 8000
# Worker:         python -m app.jobs.worker

ARG PYTHON_IMAGE=python:3.11-slim

# ---------------------------------------------------------------------------
# Stage 1: build wheels for the backend and all of its dependencies.
# ---------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY . /src
RUN pip install --upgrade pip setuptools wheel \
    && pip install "/src[gcp,aws]"

# ---------------------------------------------------------------------------
# Stage 2: minimal runtime image, non-root.
# ---------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime

LABEL org.opencontainers.image.title="analytics-platform-backend" \
      org.opencontainers.image.description="Analytics Platform API and job worker" \
      org.opencontainers.image.source="https://github.com/nelait/Aistrology/tree/main/analytics-platform"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    AP_CLOUD_PROVIDER=local \
    AP_DATA_DIR=/data \
    TMPDIR=/tmp

# Fixed UID/GID so Kubernetes runAsUser / fsGroup can match.
ARG APP_UID=10001
ARG APP_GID=10001
RUN groupadd --system --gid "${APP_GID}" app \
    && useradd --system --uid "${APP_UID}" --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /app /data \
    && chown -R app:app /app /data

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
USER 10001:10001

EXPOSE 8000

# Kubernetes uses its own probes; this is for plain `docker run` / compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
