# 🚀 生产环境部署指南

> Legacy notice: This guide was written for the old Python scripts + HTTP API.
> The Node rewrite ships a `mail-use` CLI as a GitHub Release binary. Prefer `mail-use sync daemon`
> and other CLI subcommands.

基于 Leo 的 review 建议，这里是生产环境稳定运行的完整配置指南。

## 🔧 生产环境注意事项

### 1. 固定工作目录/路径

在 cron/systemd 中使用绝对路径，确保脚本能找到配置文件与依赖。

### 2. Webhook 与密钥配置

将 Webhook 与 API Key 放在 `.env` 或系统环境变量中，避免硬编码在脚本里。

### 3. 超时与错误处理

可在 systemd 中设置 `TimeoutSec`，或在 cron 中使用 `timeout` 包装脚本。

## 🛠️ 生产环境配置步骤

### 1. 环境变量设置

创建环境变量文件或在系统中设置：

```bash
# 必需的环境变量
export FEISHU_WEBHOOK="https://open.larksuite.com/open-apis/bot/v2/hook/a56c9638-cb65-4f95-bb11-9eb19e09692a"

# 可选的 AI/HTTP API 配置
export OPENAI_API_KEY="sk-xxx"
export API_SECRET_KEY="your-secret"
```

### 2. 设置本地定时任务

```bash
# 每 5 分钟检查邮件
*/5 * * * * cd /path/to/mail-use && mail-use monitor run --json

# 每天 08:30 发送汇总
30 8 * * * cd /path/to/mail-use && mail-use digest run --json
```

### 3. 脚本权限和路径

```bash
# 确保脚本可执行
chmod +x /path/to/mail-use/dist/mail-use

# 验证 Python 路径
which python
python --version

# 测试脚本执行
cd /path/to/mail-use
mail-use monitor status --json
```

### 4. 配置文件验证

确保所有配置文件格式正确：

```bash
# 验证 JSON 格式
python -m json.tool data/notification_config.json
python -m json.tool data/email_monitor_config.json
```

## 📊 监控和日志

### 1. 定时任务监控

- 监控 cron/systemd 日志
- 设置执行失败告警

### 2. 系统日志

```bash
# 查看邮件监控日志
tail -f email_monitor.log

# 查看系统资源使用
htop
df -h
```

### 3. 健康检查

```bash
# 定期运行健康检查
python scripts/email_monitor.py status

# 查看通知统计
python scripts/notification_service.py stats 7

# 测试组件
python scripts/email_monitor.py run
```

## 🔒 安全配置

### 1. API 密钥管理

- 使用环境变量存储敏感信息
- 定期轮换 API 密钥
- 限制 API 密钥权限范围

### 2. Webhook 安全

- 使用 HTTPS URL
- 配置 webhook 签名验证（如果支持）
- 限制 webhook 访问 IP

### 3. 文件权限

```bash
# 设置合适的文件权限
chmod 600 data/notification_config.json
chmod 600 accounts.json
```

## ⚡ 性能优化

### 1. 调整监控频率

根据邮件量调整 cron 表达式：

```javascript
// 高频率 (每2分钟)
"*/2 * * * *"

// 中频率 (每5分钟) - 推荐
"*/5 * * * *"

// 低频率 (每15分钟)
"*/15 * * * *"
```

### 2. 脚本超时设置

```json
{
  "options": {
    "timeout": 600000  // 10分钟超时
  }
}
```

### 3. 批量处理优化

```json
{
  "email": {
    "fetch_limit": 50,  // 增加批量大小
    "unread_only": true
  }
}
```

## 🚨 故障排除

### 1. 常见错误处理

| 错误类型 | 可能原因 | 解决方案 |
|----------|----------|----------|
| 退出码非零 | 脚本执行失败 | 检查 stderr，修复脚本问题 |
| JSON 解析失败 | 脚本输出格式错误 | 检查脚本输出，修复格式 |
| Webhook 发送失败 | 网络或 URL 问题 | 验证 URL 和网络连接 |
| 权限错误 | 文件或目录权限不足 | 检查并修复文件权限 |

### 2. 调试技巧

```bash
# 手动执行脚本查看详细输出
cd /path/to/mail-use
python scripts/email_monitor.py run --verbose

# 检查环境变量
env | grep -E "(FEISHU|OPENAI|API_SECRET|TELEGRAM)"

# 测试 webhook
curl -X POST "$FEISHU_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d '{"msg_type":"text","content":{"text":"测试消息"}}'
```

### 3. 日志分析

```bash
# 查找错误模式
grep -i error email_monitor.log | tail -10

# 统计成功率
grep -c "SUCCESS" email_monitor.log
grep -c "ERROR" email_monitor.log

# 查看最近的执行
tail -50 email_monitor.log | grep -E "(INFO|ERROR|WARNING)"
```

## 📈 扩展配置

### 1. 多环境支持

```bash
# 开发环境
export FEISHU_WEBHOOK="$DEV_FEISHU_WEBHOOK"

# 生产环境
export FEISHU_WEBHOOK="$PROD_FEISHU_WEBHOOK"
```

### 2. 负载均衡

如果有多个调度实例：

```bash
# 使用不同的 cron 偏移
# 实例1: "0 */5 * * *"  (每5分钟的0秒)
# 实例2: "2 */5 * * *"  (每5分钟的2秒)
```

### 3. 备份和恢复

```bash
# 备份配置文件
tar -czf email_monitor_backup_$(date +%Y%m%d).tar.gz \
  *.json scripts/ config_templates/

# 恢复配置
tar -xzf email_monitor_backup_YYYYMMDD.tar.gz
```

## ✅ 部署检查清单

- [ ] 环境变量已设置并验证
- [ ] 定时任务已配置并测试
- [ ] 脚本权限和路径正确
- [ ] 配置文件格式验证通过
- [ ] Webhook 连接测试成功
- [ ] 完整流程测试通过
- [ ] 日志监控已配置
- [ ] 错误告警已设置
- [ ] 备份策略已制定
- [ ] 文档已更新

## 📞 技术支持

遇到问题时的排查顺序：

1. 检查定时任务执行记录和错误信息
2. 查看脚本日志文件
3. 手动执行脚本验证
4. 检查环境变量和配置
5. 验证网络连接和权限
6. 查看系统资源使用情况

---

**注意**: 这个配置已经根据 Leo 的 review 建议进行了完整的生产环境优化，可以稳定运行。
