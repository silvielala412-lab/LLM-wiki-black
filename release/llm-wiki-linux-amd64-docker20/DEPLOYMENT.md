# LLM Wiki 内网 Linux 部署手册

## 1. 交付范围

本部署包适用于：

- Linux `x86_64/amd64`
- Docker Engine `20.10+`
- Docker Compose Plugin，或旧版 `docker-compose`
- 无外网环境；镜像已经离线打包

交付目录包含：

| 文件 | 用途 |
|---|---|
| `llm-wiki-image.tar.gz` | Linux amd64 Docker 离线镜像 |
| `llm-wiki-image.sha256` | 镜像包 SHA-256 校验文件 |
| `docker-compose.yml` | 容器、端口、数据卷和模型环境变量定义 |
| `.env.example` | 配置模板，不包含真实 Key |
| `deploy.sh` | 校验、加载镜像并启动服务 |
| `README.txt` | 快速部署说明 |
| `DEPLOYMENT.md` | 本详细部署手册 |

镜像标签：`llm-wiki:0.4.3-linux-amd64`

## 2. `.env` 文件在哪里

交付包中不会预置 `.env`，只有 `.env.example`。这是为了防止模型地址和 API Key 被打进镜像或提交到 Git。

将部署包放到 `/opt/llm-wiki` 后，执行：

```bash
cd /opt/llm-wiki
cp .env.example .env
chmod 600 .env
vi .env
```

此时真实配置文件路径为：

```text
/opt/llm-wiki/.env
```

`.env` 是隐藏文件，普通 `ls` 看不到，应使用：

```bash
ls -la /opt/llm-wiki
```

如果直接运行 `./deploy.sh` 且 `.env` 不存在，脚本也会自动从模板创建 `.env`，然后退出并提示先填写配置。

## 3. 部署前检查

### 3.1 检查服务器架构

```bash
uname -m
```

预期输出为 `x86_64`。如果是 `aarch64` 或 `arm64`，不能使用当前镜像包。

### 3.2 检查 Docker

```bash
docker version
docker info
```

Docker Server 版本应为 `20.10+`，且执行用户必须有访问 Docker daemon 的权限。

### 3.3 检查 Compose

以下任意一个命令可用即可：

```bash
docker compose version
docker-compose version
```

Docker Engine 20 并不一定自带 Compose。如果两个命令都不可用，需要由服务器管理员离线安装 Compose Plugin 或 `docker-compose`。

### 3.4 检查磁盘和端口

```bash
df -h /opt /var/lib/docker
ss -lntp | grep 8231 || true
```

确保 Docker 数据目录和 `/opt` 有足够空间，并确认 `8231` 没有被其他服务占用。远程浏览器访问时，服务器防火墙还需要放行 TCP `8231`。

## 4. 上传部署包

建议将整个 `llm-wiki-linux-amd64-docker20` 目录上传到服务器，再重命名为 `/opt/llm-wiki`。上传完成后目录结构应类似：

```text
/opt/llm-wiki/
├── .env.example
├── DEPLOYMENT.md
├── README.txt
├── deploy.sh
├── docker-compose.yml
├── llm-wiki-image.sha256
└── llm-wiki-image.tar.gz
```

## 5. 配置主 LLM

当前版本的知识抽取和问答默认共用一套主 LLM。编辑 `/opt/llm-wiki/.env`：

```env
HOST_PORT=8231
RUST_LOG=llm_wiki_server=info,tower_http=warn

LLM_PROVIDER=custom
LLM_ENDPOINT=http://10.10.10.20:8000/v1
LLM_API_KEY=替换为真实LLM_KEY
LLM_MODEL=替换为模型名称
LLM_API_MODE=chat_completions
LLM_MAX_CONTEXT=128000

SERVER_CONFIG_LOCKED=true
```

主 LLM 接口需要兼容 OpenAI Chat Completions 请求格式。一般填写 `/v1` 根地址，应用会调用对应的聊天补全接口。

`SERVER_CONFIG_LOCKED=true` 表示地址、模型和 Key 由服务器统一管理，前端用户不能覆盖。当前部署版本还没有将“抽取模型”和“问答模型”拆成两套独立配置。

## 6. 配置 OCR、视觉和向量模型

### 6.1 内网多模态 OCR

内网 OCR 实际是一个多模态识别模型，由独立的 multipart 接口对外提供服务。当前接口不需要 API Key，应用不会发送认证头。

镜像已经包含该接口的调用代码、`pdf-extract`、`pdftotext` 和 `pdftoppm`，但不包含多模态 OCR 模型服务本身。

如果需要识别扫描件 PDF，可配置：

```env
OCR_ENDPOINT=http://10.10.10.30:8088/api/ocr
OCR_USER_TEXT=识别文件中的所有文字
OCR_ACTION_SCENARIO=111
PDF_DPI=150
PDF_OCR_MODE=auto
```

OCR 请求契约：

```text
POST multipart/form-data
file: PDF 或图片二进制
user_text: 识别指令
action_scenario: 场景编号
```

OCR 响应契约：

```json
{
  "code": 0,
  "message": "操作成功",
  "data": {
    "robot_text": "识别出的全文"
  }
}
```

配置 `OCR_ENDPOINT` 后，PDF 会优先发送给该多模态 OCR 模型；调用失败才会降级到本地文字层抽取。只有文字型 PDF 时可暂不配置 OCR。

虽然底层是多模态模型，但它使用 `file + user_text + action_scenario` 专用协议，因此应配置在 `OCR_ENDPOINT`，而不是 `VISION_ENDPOINT`。

### 6.2 视觉模型

图片文件或 PDF 页面图像需要视觉模型时，可配置 OpenAI 兼容的多模态接口：

```env
VISION_ENDPOINT=http://10.10.10.21:8000/v1
VISION_MODEL=替换为视觉模型名称
VISION_API_KEY=替换为视觉模型KEY
```

`VISION_ENDPOINT` 仅用于 OpenAI 兼容的多模态接口。已经配置上述内网 OCR，且不处理其他图片时，`VISION_*` 可以留空。

### 6.3 Embedding 模型

Embedding 用于语义检索和相关知识召回，建议生产环境配置：

```env
EMBEDDING_ENDPOINT=http://10.10.10.22:8000/v1/embeddings
EMBEDDING_MODEL=替换为向量模型名称
EMBEDDING_API_KEY=替换为向量模型KEY
```

## 7. 容器访问模型服务的地址

容器里的 `127.0.0.1` 和 `localhost` 指向容器自身，不是 Linux 宿主机。

- 模型在其他内网服务器：填写该服务器的真实内网 IP。
- 模型在同一台 Linux 宿主机：可使用 `host.docker.internal`。
- 模型也由 Compose 管理：可使用对应的 Compose service 名称。

同宿主机示例：

```env
LLM_ENDPOINT=http://host.docker.internal:8000/v1
```

模型服务必须监听宿主机可达地址，例如 `0.0.0.0:8000`，只监听 `127.0.0.1` 时容器通常无法访问。

可先从宿主机检查网络：

```bash
curl -v --connect-timeout 5 http://10.10.10.20:8000/v1/models
```

返回 `200` 表示接口可访问；返回 `401` 通常也表示网络已通，只是需要认证。连接超时或拒绝连接需要检查监听地址、路由和防火墙。

## 8. 一键部署

```bash
cd /opt/llm-wiki
cp .env.example .env
chmod 600 .env
vi .env
chmod +x deploy.sh
./deploy.sh
```

`deploy.sh` 会依次执行：

1. 检查 `.env` 是否存在且已替换主 LLM 占位配置。
2. 使用 `sha256sum` 校验离线镜像包。
3. 解压并执行 `docker load`。
4. 创建持久化目录 `./data`。
5. 自动选择 `docker compose` 或 `docker-compose` 启动服务。

脚本不会访问公网拉取镜像。

## 9. 手动部署方法

不使用脚本时可执行：

```bash
cd /opt/llm-wiki
sha256sum -c llm-wiki-image.sha256
gzip -dc llm-wiki-image.tar.gz | docker load
mkdir -p data
docker compose up -d
```

旧版 Compose 使用：

```bash
docker-compose up -d
```

## 10. 部署验证

### 10.1 查看容器状态

```bash
docker ps --filter name=llm-wiki
docker inspect --format '{{.State.Health.Status}}' llm-wiki
```

健康状态最终应为 `healthy`。

### 10.2 检查服务接口

```bash
curl http://127.0.0.1:8231/api/health
curl http://127.0.0.1:8231/api/config
```

健康接口预期返回 `ok`。配置接口可用于确认 LLM、Vision、OCR 和 Embedding 是否被服务读取，但不会返回真实 Key。

### 10.3 浏览器访问

```text
http://服务器IP:8231
```

首次验收建议：

1. 新建一个测试项目。
2. 上传一个小型文字 PDF，验证解析和知识抽取。
3. 上传一个扫描件，验证 OCR。
4. 对刚生成的知识发起问答，验证主 LLM 和检索链路。

健康接口正常只代表 Web 服务已启动，不代表外部模型接口一定可用，必须再做一次真实抽取和问答。

## 11. 日志和排障

查看最近日志：

```bash
docker logs --tail 200 llm-wiki
```

持续查看日志：

```bash
docker logs -f --tail 200 llm-wiki
```

日志使用 Docker `json-file` 驱动，单文件最大 `50 MB`，最多保留 `5` 个文件。

常见问题：

| 现象 | 检查项 |
|---|---|
| 浏览器打不开 | 容器状态、8231 端口、防火墙、服务器 IP |
| 显示 LLM 未配置 | `.env` 中 `LLM_ENDPOINT/LLM_API_KEY/LLM_MODEL`，以及是否重新创建容器 |
| LLM 请求超时 | 容器到模型服务器的路由、防火墙、模型监听地址 |
| 返回 401/403 | Key、认证头、模型服务权限 |
| 返回 404 | Endpoint 是否应填写 `/v1`，接口是否兼容 Chat Completions |
| 文字 PDF 可用但扫描件失败 | `OCR_ENDPOINT` 或 `VISION_*` 是否配置 |
| OCR 返回解析错误 | 响应是否满足 `code=0` 且包含 `data.robot_text` |
| 语义搜索效果弱 | Embedding 服务是否配置并可访问 |

## 12. 修改配置后重启

修改 `/opt/llm-wiki/.env` 后必须重新创建容器：

```bash
cd /opt/llm-wiki
docker compose up -d --force-recreate
```

旧版 Compose：

```bash
docker-compose up -d --force-recreate
```

然后再次检查：

```bash
curl http://127.0.0.1:8231/api/config
docker logs --tail 100 llm-wiki
```

## 13. 数据目录与备份

项目数据保存在：

```text
/opt/llm-wiki/data
```

该目录通过 Compose 映射到容器内 `/data`。删除或重建容器不会删除此目录，但删除宿主机上的 `data` 会丢失项目数据。

建议备份前短暂停止服务：

```bash
cd /opt/llm-wiki
docker compose stop
tar -czf /opt/llm-wiki-data-$(date +%F-%H%M%S).tar.gz data
docker compose start
```

生产环境应将备份文件复制到独立磁盘或备份服务器，并定期验证可恢复性。

## 14. 升级与回滚

升级前：

1. 备份 `data`。
2. 备份当前 `.env`。
3. 保留当前镜像归档和 Compose 文件。
4. 替换新版本交付文件并执行新版本 `deploy.sh`。
5. 强制重新创建容器并完成真实抽取、OCR 和问答验收。

```bash
docker compose up -d --force-recreate
```

如需回滚，重新加载旧版本镜像归档、恢复对应 Compose 文件并强制重新创建容器。不要在未备份的情况下覆盖 `data`。

## 15. 安全建议

- `.env` 权限设置为 `600`，不要提交 Git 或通过聊天工具传播。
- 能访问 Docker daemon 的用户通常也能读取容器环境变量，应严格限制 `root` 和 `docker` 组成员。
- 对外提供服务时建议在前面增加 Nginx/网关，启用 HTTPS、访问控制和审计日志。
- 仅向业务网段开放 `8231`，不要直接暴露到互联网。
- 定期轮换 LLM、Vision 和 Embedding API Key；当前内网多模态 OCR 接口无 Key。
