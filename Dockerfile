# ── Stage 1: Build Rust HTTP server ──────────────────────────────────────────
# ubuntu:22.04: glibc 2.35, apt protoc 3.21.x (satisfies lance-encoding ≥ 3.15)
FROM ubuntu:22.04 AS rust-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential pkg-config \
    libssl-dev ca-certificates \
    perl make git \
    protobuf-compiler libprotobuf-dev \
    && rm -rf /var/lib/apt/lists/*

# protoc binary + well-known .proto includes (google/protobuf/empty.proto etc.)
ENV PROTOC=/usr/bin/protoc
ENV PROTOC_INCLUDE=/usr/include

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
# public/ is optional in this project
RUN if [ -d public ]; then cp -r public ./public; fi

RUN npx vite build

# ── Stage 3: Minimal runtime image ───────────────────────────────────────────
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/* ; \
    useradd -r -u 1001 -g 0 -s /bin/false -M wiki 2>/dev/null || true

WORKDIR /app

COPY --from=rust-builder  /build/target/release/llm-wiki-server .
COPY --from=frontend-builder /build/dist ./dist

RUN mkdir -p /data /app && chown -R 1001:0 /app /data

USER 1001

ENV APP_HOST=0.0.0.0
ENV APP_PORT=8000
ENV WIKI_DATA_PATH=/data
ENV STATIC_DIR=/app/dist
ENV RUST_LOG=info

# ── LLM 服务端配置（管理员设置，不需要用户配置）──────────────
# 示例：docker run -e LLM_ENDPOINT=http://内网IP:8080/v1 -e LLM_MODEL=deepseek-chat ...
ENV LLM_PROVIDER=
ENV LLM_API_KEY=
ENV LLM_MODEL=
ENV LLM_ENDPOINT=
ENV LLM_API_MODE=chat_completions
ENV LLM_MAX_CONTEXT=
# Embedding 服务
ENV EMBEDDING_ENDPOINT=
ENV EMBEDDING_MODEL=
# 多模态/视觉模型（图片型 PDF OCR，页面级）
ENV VISION_ENDPOINT=
ENV VISION_MODEL=
# PDF 转图 DPI：150（默认）或 200（表格密集场景）
ENV PDF_DPI=150
# ── 内网 PDF OCR 专用 API（整文档一次性识别，优先级最高）──────
# 接口格式：POST multipart/form-data，字段：user_text + action_scenario + file
# 响应格式：{ "code": 0, "data": { "robot_text": "全文..." } }
# 不填则降级到 pdf-extract → pdftoppm 方案
ENV OCR_ENDPOINT=
# OCR 服务的业务参数，可按内网接口约定覆盖
ENV OCR_USER_TEXT=识别文件中的所有文字
ENV OCR_ACTION_SCENARIO=111
# OCR 服务的 API Key（如果需要，以 Bearer token 方式发送）
ENV OCR_API_KEY=
# 用户是否可覆盖服务端配置：true=可以覆盖 false=锁定
ENV SERVER_CONFIG_LOCKED=false


EXPOSE 8000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -sf http://localhost:8000/api/health || exit 1

CMD ["./llm-wiki-server"]
