# 🚀 HTTP API 方案快速开始

> Legacy notice: This document describes a Python HTTP API service that no
> longer ships with this repository.
>
> The supported interface is the `mail-use` CLI (Node.js) installed via
> `npm i -g @leeguoo/mail-use`.

**推荐架构**: Python HTTP 服务 + 本地定时任务/脚本调用

## ⚡ 3 步部署

### 1. 启动 Python API 服务

```bash
# 开发环境 - 自动重载
uv run python scripts/email_monitor_api.py

# 或使用 uvicorn (推荐)
uv run uvicorn scripts.email_monitor_api:app --reload --host 0.0.0.0 --port 18888
```

**服务启动后**:
- API 地址: `http://localhost:18888`
- 健康检查: `http://localhost:18888/health`
- API 文档: `http://localhost:18888/docs`

### 2. 测试 API

```bash
# 健康检查
curl http://localhost:18888/health

# 测试邮件检查
curl -X POST http://localhost:18888/api/check-emails

# 测试通知
curl -X POST http://localhost:18888/api/test-notification
```

### 3. 添加本地定时任务（可选）

```bash
# 直接运行脚本（无需 HTTP API）
uv run python scripts/email_monitor.py run

# 使用 cron 调度（每 5 分钟）
*/5 * * * * cd /path/to/mail-use && mail-use monitor run --json

# 每天 08:30 生成汇总
30 8 * * * cd /path/to/mail-use && mail-use digest run --json
```

## 📊 架构图

```
┌─────────────────┐
│ 本地定时任务/脚本 │
│ (cron/schedule) │
└────────┬────────┘
         │ HTTP Request (可选)
         ↓
┌─────────────────┐
│  FastAPI Service│ ← 你的服务器
│  (Port 18888)   │
└────────┬────────┘
         │ 调用
         ↓
┌─────────────────┐
│  Python MCP     │
│  (邮件处理)     │
└─────────────────┘
         │ 返回结果
         ↓
┌─────────────────┐
│ 通知发送         │
│ (Lark/Telegram) │
└─────────────────┘
```

## 🔧 API 调用示例

通过 HTTP API 触发检查：

- **本地测试**: `http://localhost:18888/api/check-emails`
- **服务器部署**: `http://your-server-ip:18888/api/check-emails`
- **域名部署**: `https://api.yourdomain.com/api/check-emails`

## 🏭 生产部署

### 选项 1: systemd 服务

```bash
# 创建服务文件
sudo tee /etc/systemd/system/email-monitor-api.service <<EOF
[Unit]
Description=Email Monitor API Service
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/mail-use
Environment="PATH=/path/to/.venv/bin"
ExecStart=/path/to/.venv/bin/uvicorn scripts.email_monitor_api:app --host 0.0.0.0 --port 18888
Restart=always

[Install]
WantedBy=multi-user.target
EOF

# 启动服务
sudo systemctl enable email-monitor-api
sudo systemctl start email-monitor-api
sudo systemctl status email-monitor-api
```

### 选项 2: Docker 部署

```dockerfile
# Dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY . /app

RUN pip install uv && \\
    uv sync

EXPOSE 18888

CMD ["uv", "run", "uvicorn", "scripts.email_monitor_api:app", "--host", "0.0.0.0", "--port", "18888"]
```

```bash
# 构建和运行
docker build -t email-monitor-api .
docker run -d -p 18888:18888 --name email-api email-monitor-api
```

### 选项 3: Nginx 反向代理

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:18888;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 📝 API 接口文档

### POST /api/check-emails

检查邮件并返回重要邮件

**响应示例**:
```json
{
  "success": true,
  "message": "Monitoring cycle completed successfully",
  "stats": {
    "fetched_emails": 20,
    "important_emails": 3,
    "notifications_sent": 1
  },
  "important_emails": [
    {
      "from": "boss@company.com",
      "subject": "Urgent: Project Deadline",
      "priority_score": 0.9
    }
  ],
  "notification": {
    "msg_type": "interactive",
    "card": { ... }
  }
}
```

### GET /health

健康检查

**响应**:
```json
{
  "status": "healthy",
  "service": "email-monitor-api"
}
```

### POST /api/test-notification

测试通知（不实际检查邮件）

## 🔒 安全建议

### 1. 添加 API 认证

```python
from fastapi import Header, HTTPException

API_KEY = os.getenv("API_KEY", "your-secret-key")

async def verify_api_key(x_api_key: str = Header()):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API Key")
    return x_api_key

# 在路由中使用
@app.post("/api/check-emails", dependencies=[Depends(verify_api_key)])
async def check_emails():
    ...
```

### 2. 使用 HTTPS

```bash
# 使用 Let's Encrypt
sudo certbot --nginx -d api.yourdomain.com
```

### 3. 限流

```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@app.post("/api/check-emails")
@limiter.limit("10/minute")
async def check_emails(request: Request):
    ...
```

## 🎯 使用方式对比

| 特性 | 直接脚本（cron/schedule） | HTTP API |
|------|-------------------------|----------|
| 部署复杂度 | 低 | 中 |
| 可扩展性 | 中 | 高 |
| 监控调试 | 简单 | 简单 |
| 调度方式 | 本地定时 | 任意 HTTP 调用 |

## ✅ 现在可以

1. **本地测试**: 启动 API 或直接运行脚本
2. **生产部署**: systemd/Docker + 配置域名（HTTP API 可选）
3. **开始使用**: 配置 cron 或常驻进程

**HTTP API 是可选组件，直接脚本也可完成全部流程。** 🎉
