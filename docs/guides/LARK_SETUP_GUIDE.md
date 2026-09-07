# 🚀 飞书 Webhook 邮件监控快速设置指南

你的飞书 webhook 已经测试成功！现在可以快速设置完整的邮件监控系统。

## ✅ 已完成的配置

- **飞书 Webhook**: `https://open.larksuite.com/open-apis/bot/v2/hook/a56c9638-cb65-4f95-bb11-9eb19e09692a`
- **测试状态**: ✅ 通过（文本和卡片消息都正常）
- **配置文件**: 已创建 `data/notification_config.json`

## 🎯 下一步操作

### 1. 配置邮件账户

如果还没有配置邮件账户：

```bash
python setup.py
```

### 2. 测试完整流程

```bash
# 测试完整监控流程
python scripts/email_monitor.py run

# 测试每日汇总
python scripts/daily_email_digest.py run
```

### 3. 设置本地定时任务

使用 cron 或常驻进程运行：

```bash
# 每 5 分钟检查邮件
*/5 * * * * cd /path/to/mail-use && mail-use monitor run --json

# 每天 08:30 发送汇总
30 8 * * * cd /path/to/mail-use && mail-use digest run --json
```

## 📱 飞书通知效果

你将收到两种类型的通知：

### 📧 邮件通知
当系统检测到邮件时，会发送卡片消息：
- 📧 **主题**: 邮件标题
- 👤 **发件人**: 发件人信息  
- ⏰ **时间**: 接收时间
- 🎯 **重要性**: 优先级评分 (0-100%)
- 🏷️ **分类**: general (默认)
- 🤖 **分析原因**: 系统说明
- 👀 **预览**: 邮件内容预览
- 💡 **建议操作**: reply/forward/archive 等

### 📊 系统监控报告
每次运行会发送系统状态：
- 📥 获取邮件数量
- ⚠️ 重要邮件数量
- 📤 发送通知数量
- 🟢/🔴 运行状态

## ⚙️ 自定义配置

### 调整监控频率

通过 cron 或守护进程调整：
- 每 5 分钟: `*/5 * * * *`
- 每 10 分钟: `*/10 * * * *`
- 每小时: `0 * * * *`

### 调整通知模板

编辑 `data/notification_config.json` 中的 `templates` 部分，可以自定义消息格式。

## 🧪 测试命令

```bash
# 测试飞书 webhook
python scripts/test_lark_webhook.py

# 测试完整监控
python scripts/email_monitor.py test

# 查看系统状态
python scripts/email_monitor.py status
```

## 🚨 故障排除

### 常见问题

1. **邮件获取失败**
   ```bash
   # 检查邮件配置
   uv run python -m clients.mailbox_client list-accounts
   ```

2. **通知发送失败**
   ```bash
   # 测试 webhook
   python scripts/test_lark_webhook.py
   ```

### 查看日志

```bash
# 查看监控日志
tail -f email_monitor.log

# 查看通知统计
python scripts/notification_service.py stats 7
```

## 🎉 完成！

一旦设置完成，你的系统将：

1. ⏰ **每 5 分钟自动检查**新邮件
2. 📱 **飞书实时通知**新邮件
3. 🔄 **自动去重**避免重复通知
4. 📊 **运行统计**监控系统健康

享受智能邮件管理的便利吧！🚀

---

## 📞 需要帮助？

- 查看快速开始: `docs/guides/HTTP_API_QUICK_START.md`
- 查看本地配置: `config_templates/daily_digest_config.example.json`
