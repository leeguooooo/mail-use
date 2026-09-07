# ✅ 最终部署验证清单（本地定时）

## 📅 部署信息

- **部署日期**: 2025-10-16
- **调度方式**: cron/systemd
- **主要任务**: 邮件监控与每日汇总

---

## ✅ 代码质量验证

### 1. 基础检查

```bash
# 安装依赖
uv sync

# 可选：运行测试
uv run pytest
```

### 2. 关键脚本可用性

```bash
# 监控脚本
python scripts/email_monitor.py status

# 汇总脚本
python scripts/daily_email_digest.py config
```

---

## 🔧 配置一致性验证

### 必需配置

- `data/accounts.json` 已配置邮箱账户
- `data/notification_config.json` 已配置通知渠道
- `data/daily_digest_config.json` 已配置汇总参数

### 环境变量（可选）

```bash
OPENAI_API_KEY=sk-xxx
API_SECRET_KEY=your-secret
FEISHU_WEBHOOK=https://open.larksuite.com/open-apis/bot/v2/hook/xxx
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
TELEGRAM_CHAT_ID=123456789
```

---

## 🚀 部署状态

### 1. 可选 HTTP API

```bash
uv run uvicorn scripts.email_monitor_api:app --host 0.0.0.0 --port 18888 &
```

### 2. 本地定时任务

```bash
# 每 5 分钟检查邮件
*/5 * * * * cd /path/to/mail-use && mail-use monitor run --json

# 每天 08:30 发送汇总
30 8 * * * cd /path/to/mail-use && mail-use digest run --json
```

---

## ✅ 部署检查清单

- [ ] 环境变量已设置并验证
- [ ] 监控与汇总配置文件已创建
- [ ] 脚本权限和路径正确
- [ ] 定时任务已配置并测试
- [ ] Webhook 连接测试成功
- [ ] 完整流程测试通过
- [ ] 日志监控已配置
- [ ] 备份策略已制定
- [ ] 文档已更新

---

## 📝 下一步操作

1. 设置 `.env` 或系统环境变量
2. 启动 API（如需 HTTP 调用）
3. 配置 cron/systemd 定时任务
4. 运行一次验证命令：
   - `python scripts/email_monitor.py run`
   - `python scripts/daily_email_digest.py run`

---

**说明**: 项目已切换为本地定时任务方案，所有部署步骤以本文件为准。
