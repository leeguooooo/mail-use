# 🐳 Docker 部署 (Legacy)

本目录为旧 Python/HTTP API 时代的 Docker 配置备份。

Node CLI 重写后，推荐使用 npm 安装 `mail-use` 并运行 `mail-use`。

该目录内容暂不维护，后续可能移除。

## 📁 文件说明

- **Dockerfile.optimized** - 优化的生产环境 Dockerfile
- **Dockerfile.optional** - 可选的 Docker 配置
- **.dockerignore** - Docker 构建忽略文件

## 🚀 快速开始

### 构建镜像

```bash
# 使用优化版本（推荐）
docker build -f docker/Dockerfile.optimized -t mail-use:latest .

# 使用可选版本
docker build -f docker/Dockerfile.optional -t mail-use:optional .
```

### 运行容器

```bash
docker run -d \
  --name mail-use \
  -v $(pwd)/accounts.json:/app/accounts.json \
  -v $(pwd)/sync_config.json:/app/sync_config.json \
  -p 18888:18888 \
  -e OPENAI_API_KEY="your-key" \
  -e API_SECRET_KEY="your-secret" \
  mail-use:latest
```

## 📝 环境变量

必需的环境变量：
- `OPENAI_API_KEY` - OpenAI API 密钥（用于翻译）
- `API_SECRET_KEY` - API 认证密钥

可选的环境变量：
- `API_BASE_URL` - HTTP API 基础地址
- `FEISHU_WEBHOOK` - 飞书 Webhook URL
- `TELEGRAM_BOT_TOKEN` - Telegram Bot Token
- `TELEGRAM_CHAT_ID` - Telegram Chat ID

## 🔧 配置文件

容器需要以下配置文件：
- `accounts.json` - 邮箱账号配置
- `sync_config.json` - 同步配置（可选）

建议使用 volume 挂载这些文件到容器中。

## 📚 更多文档

- [主文档](../README.md)
- [部署指南](../docs/guides/PRODUCTION_DEPLOYMENT_GUIDE.md)
- [安全配置](../docs/guides/SECURITY_SETUP_GUIDE.md)
