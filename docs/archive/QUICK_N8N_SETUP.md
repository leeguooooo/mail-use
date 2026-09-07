# ⚡ n8n 快速设置指南

使用你的 n8n API Key 自动设置邮件监控工作流。

## 🚀 3 步完成设置

### 方法 A: 使用 .env 文件 (推荐)

#### 1. 创建 .env 文件
```bash
./scripts/create_env.sh
```

交互式设置会引导你输入：
- N8N_API_KEY (必需)

#### 2. 测试连接
```bash
uv run python scripts/test_n8n_api.py
```

### 方法 B: 使用环境变量

#### 1. 设置 N8N_API_KEY
```bash
export N8N_API_KEY="your_n8n_api_key_here"
```

#### 2. 测试连接
```bash
uv run python scripts/test_n8n_api.py
```

**期望输出**:
```
🚀 n8n API 连接测试

🔍 测试 n8n API 连接...
   URL: https://n8n.ifoodme.com
   API Key: ********************abcd1234

✅ n8n API 连接成功!
   当前工作流数量: 3

📋 现有工作流:
   🟢 激活 My Workflow 1 (ID: 1)
   ⚪ 未激活 My Workflow 2 (ID: 2)

✨ 可以开始导入工作流了!
   运行: ./setup_n8n.sh
```

### 3. 自动导入工作流

```bash
./setup_n8n.sh
```

脚本会自动：
- ✅ 读取工作流配置
- ✅ 更新脚本路径
- ✅ 导入到 n8n
- ✅ 提供激活选项

## 🎯 配置信息

脚本会自动使用以下配置：

| 配置项 | 值 |
|--------|-----|
| n8n URL | `https://n8n.ifoodme.com` |
| 飞书 Webhook | `https://open.larksuite.com/open-apis/bot/v2/hook/a56c9638-cb65-4f95-bb11-9eb19e09692a` |
| 脚本路径 | `/path/to/mail-use` |
| Python 路径 | 自动添加到 PYTHONPATH |

## 🔧 可选配置

### 自定义 n8n URL

```bash
export N8N_URL="https://your-n8n-instance.com"
```

### 自定义飞书 Webhook

```bash
export FEISHU_WEBHOOK="your_custom_webhook_url"
```

## 📝 详细步骤说明

### 测试脚本输出

```bash
$ uv run python scripts/test_n8n_api.py

🚀 n8n API 连接测试

🔍 测试 n8n API 连接...
   URL: https://n8n.ifoodme.com
   API Key: ********************abcd1234

✅ n8n API 连接成功!
   当前工作流数量: 5

📋 现有工作流:
   🟢 激活 Email Monitor (ID: 123)
   ⚪ 未激活 Backup Workflow (ID: 124)

✨ 可以开始导入工作流了!
   运行: ./setup_n8n.sh
```

### 设置脚本输出

```bash
$ ./setup_n8n.sh

🚀 n8n 工作流自动设置

⚙️  配置信息:
   n8n URL: https://n8n.ifoodme.com
   飞书 Webhook: https://open.larksuite.com/open-apis/bot/v2/hook...
脚本路径: /path/to/mail-use

🔍 测试 n8n API 连接...
✅ n8n API 连接成功: https://n8n.ifoodme.com
📋 当前工作流数量: 5

📦 开始导入工作流...

📁 读取工作流文件: n8n/email_monitoring_workflow.json
   工作流名称: 智能邮件监控与通知

📤 正在创建工作流: 智能邮件监控与通知
✅ 工作流创建成功!
   工作流 ID: 126
   名称: 智能邮件监控与通知

✅ 工作流设置完成!
   ID: 126
   名称: 智能邮件监控与通知
   URL: https://n8n.ifoodme.com/workflow/126

💡 提示:
   1. 请在 n8n 界面中检查工作流配置
   2. 确认环境变量设置正确:
      - FEISHU_WEBHOOK
      - PYTHONPATH
   3. 测试工作流执行

是否立即激活工作流? (y/N): y

✅ 工作流已激活！系统将每5分钟自动运行。

🔗 访问工作流: https://n8n.ifoodme.com/workflow/126

✅ 设置完成！

📝 下一步:
   1. 访问 https://n8n.ifoodme.com
   2. 检查工作流配置
   3. 激活工作流
```

## ❌ 常见问题

### 1. API Key 错误

**问题**: `❌ 认证失败 (HTTP 401)`

**解决**:
```bash
# 重新设置 API Key
export N8N_API_KEY="correct_api_key"

# 再次测试
uv run python scripts/test_n8n_api.py
```

### 2. 连接失败

**问题**: `❌ 连接失败: 无法连接到 https://n8n.ifoodme.com`

**解决**:
- 检查网络连接
- 确认 n8n URL 是否正确
- 验证 n8n 服务是否运行

### 3. 权限不足

**问题**: `❌ 权限不足 (HTTP 403)`

**解决**:
- 确认 API Key 有工作流管理权限
- 在 n8n 中重新生成 API Key

### 4. 工作流已存在

脚本会自动检测并询问是否更新现有工作流。

## 🎉 完成后

访问你的 n8n 实例查看工作流：
- **URL**: https://n8n.ifoodme.com/
- **工作流名称**: 智能邮件监控与通知
- **运行频率**: 每 5 分钟

系统会自动：
1. ⏰ 每 5 分钟检查新邮件
2. 🤖 AI 判断邮件重要性
3. 📱 发送飞书通知
4. 🔄 避免重复通知

## 📚 更多信息

- **详细设置**: [N8N_API_SETUP_GUIDE.md](N8N_API_SETUP_GUIDE.md)
- **完整文档**: [N8N_EMAIL_MONITORING_GUIDE.md](N8N_EMAIL_MONITORING_GUIDE.md)
- **生产部署**: [PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md)

---

**现在就开始吧！只需要 3 个命令 🚀**
