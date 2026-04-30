# ── Stage 1: Build Rust HTTP server ──────────────────────────────────────────
# Use ubuntu:18.04 so glibc 2.27 matches the target runtime
FROM ubuntu:18.04 AS rust-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl build-essential pkg-config \
    libssl-dev ca-certificates git \
    perl make python3 \
    && rm -rf /var/lib/apt/lists/*

# cmake >= 3.21 needed by some lancedb deps — install via pip3
RUN apt-get update && apt-get install -y python3-pip && rm -rf /var/lib/apt/lists/* \
    && pip3 install --quiet cmake==3.28.0

# Install Rust stable
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /build

# Cache dependencies (only re-download when Cargo.toml changes)
COPY server-rs/Cargo.toml server-rs/Cargo.lock* ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && \
    cargo fetch && \
    cargo build --release 2>/dev/null; rm -rf src target/release/llm-wiki-server

# Build actual binary
COPY server-rs/src ./src
RUN touch src/main.rs && cargo build --release

# ── Stage 2: Build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /build

# Cache npm deps
COPY package.json package-lock.json* ./
RUN npm ci --prefer-offline || npm install

# Copy frontend source (exclude server-rs, src-tauri, etc. via .dockerignore)
COPY index.html tsconfig*.json vite.config.ts ./
COPY src ./src
COPY public ./public

RUN npm run build

# ── Stage 3: Minimal runtime image ───────────────────────────────────────────
FROM ubuntu:18.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 1001 -s /bin/false -m wiki

WORKDIR /app

COPY --from=rust-builder  /build/target/release/llm-wiki-server .
COPY --from=frontend-builder /build/dist ./dist

RUN mkdir -p /data && chown -R wiki:wiki /app /data

USER wiki

ENV APP_HOST=0.0.0.0
ENV APP_PORT=8000
ENV WIKI_DATA_PATH=/data
ENV STATIC_DIR=/app/dist
ENV RUST_LOG=info

EXPOSE 8000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -sf http://localhost:8000/api/health || exit 1

CMD ["./llm-wiki-server"]
