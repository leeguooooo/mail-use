# 原子操作升级 - 2025年10月 (Legacy)

> Legacy notice: This document describes the old MCP-style tool surface.
> The current project is a Node.js CLI (`mail-use`) with a JSON output contract.

## 🎯 升级概述

本次升级重新明确了 mail-use 的设计定位：**专注提供原子级邮件操作能力**，将高级整合功能交给上层 AI 完成。

### 核心理念

```
┌─────────────────────────────────────┐
│   AI 层 (上层调用方)                 │
│   • 决策与策略                        │
│   • 翻译、摘要、分类                  │
│   • 工作流编排                        │
└─────────────────────────────────────┘
              ⬇️ 调用
┌─────────────────────────────────────┐
│   MCP 层 (本项目)                    │
│   • 28 个原子操作工具                 │
│   • 数据访问与状态管理                │
│   • 无业务逻辑                        │
└─────────────────────────────────────┘
              ⬇️ 访问
┌─────────────────────────────────────┐
│   基础设施层                         │
│   • IMAP/SMTP                       │
│   • 缓存与同步                       │
└─────────────────────────────────────┘
```

## ✨ 新增功能

### 1. 三个新原子工具

#### `list_unread_folders`
获取各文件夹的未读邮件统计，帮助 AI 决定优先处理顺序。

```python
result = mcp.call("list_unread_folders")
# {
#   "folders": [
#     {"name": "INBOX", "unread_count": 15, "total_count": 150},
#     {"name": "Work", "unread_count": 3, "total_count": 50}
#   ]
# }
```

**使用场景**:
- AI 根据未读数决定处理优先级
- 可视化邮箱状态
- 触发清理策略

#### `get_email_headers`
只获取邮件头部，不拉取正文，高效支持 AI 快速分类。

```python
headers = mcp.call("get_email_headers", {
    "email_id": "123",
    "headers": ["From", "Subject", "Date", "Message-ID"]
})
# {
#   "headers": {
#     "From": "sender@example.com",
#     "Subject": "Meeting Tomorrow",
#     "Date": "Mon, 22 Oct 2025 10:00:00 +0000"
#   },
#   "source": "imap_headers"
# }
```

**使用场景**:
- AI 快速扫描大量邮件进行分类
- 垃圾邮件预筛选
- 规则匹配（发件人白名单等）

#### `get_recent_activity`
获取同步活动统计，让 AI 了解系统状态。

```python
activity = mcp.call("get_recent_activity")
# {
#   "accounts": [
#     {
#       "account": "user@example.com",
#       "last_sync": "2025-10-22T10:30:00Z",
#       "success_rate": 98.5,
#       "last_error": null
#     }
#   ]
# }
```

**使用场景**:
- AI 决定是否需要触发同步
- 健康度监控与告警
- 故障排查

### 2. 现有工具优化

#### 分页支持
```python
# 第一页
emails = mcp.call("list_emails", {"limit": 50, "offset": 0})

# 第二页
emails = mcp.call("list_emails", {"limit": 50, "offset": 50})

# 搜索分页
results = mcp.call("search_emails", {
    "query": "meeting",
    "limit": 20,
    "offset": 40  # 第3页
})
```

#### 元数据支持
```python
emails = mcp.call("list_emails", {"include_metadata": true})
# 每封邮件包含 "source": "cache" 或 "imap"
# AI 可根据数据来源调整策略
```

#### Dry Run 支持
```python
# 先验证
result = mcp.call("delete_emails", {
    "email_ids": ["1", "2", "3"],
    "dry_run": true
})

if result["success"]:
    # 再执行
    mcp.call("delete_emails", {
        "email_ids": ["1", "2", "3"],
        "dry_run": false
    })
```

## 📋 完整工具清单 (28个)

### 读取类 (5)
- `list_emails` ⬆️ 新增: offset, include_metadata
- `get_email_detail`
- `get_email_headers` ⭐ 新增
- `search_emails` ⬆️ 新增: offset
- `get_email_attachments`

### 状态类 (8)
- `mark_emails` ⬆️ 新增: dry_run
- `mark_email_read`
- `mark_email_unread`
- `batch_mark_read`
- `delete_emails` ⬆️ 新增: dry_run
- `delete_email`
- `batch_delete_emails`
- `flag_email`

### 组织类 (5)
- `list_folders`
- `list_unread_folders` ⭐ 新增
- `move_emails_to_folder`
- `analyze_contacts`
- `get_contact_timeline`

### 沟通类 (3)
- `send_email`
- `reply_email`
- `forward_email`

### 系统类 (7)
- `check_connection`
- `list_accounts`
- `get_recent_activity` ⭐ 新增
- `sync_emails`
- `get_sync_health`
- `get_sync_history`
- `get_connection_pool_stats`

## 📚 新增文档

### 核心文档
- **`docs/guides/MCP_DESIGN_PRINCIPLES.md`** - 设计原则与能力定位
  - 什么是原子操作
  - MCP vs AI 的职责分工
  - 最佳实践与示例

### 示例说明
- **`scripts/README.md`** - 示例脚本定位与使用
  - inbox_organizer - 收件箱整理示例
  - email_translator - 翻译示例
  - email_monitor_api - HTTP API 包装

## 🔄 迁移指南

### 如果你在使用示例脚本

**之前**:
```python
# 直接调用整合脚本
from scripts.inbox_organizer import InboxOrganizer
organizer = InboxOrganizer()
result = organizer.organize()
```

**现在** (推荐):
```python
# 在 AI 中复现逻辑，使用 MCP 原子操作
folders = mcp.call("list_unread_folders")
top_folder = max(folders, key=lambda f: f['unread_count'])

emails = mcp.call("list_emails", {"folder": top_folder['name']})
headers = [mcp.call("get_email_headers", {"email_id": e['id']}) 
           for e in emails[:10]]

spam = my_ai_classify(headers)  # 使用自己的 AI
mcp.call("delete_emails", {"email_ids": spam})
```

### 如果你在开发新功能

**❌ 不要**在 MCP 层添加业务逻辑:
```python
# 错误示例
@tool("smart_organize")
def smart_organize():
    emails = list_emails()
    spam = ai_model.classify_spam(emails)  # ❌ AI 能力
    summary = translate(emails)  # ❌ 翻译能力
    return {"spam": spam, "summary": summary}
```

**✅ 应该**让 AI 组合原子操作:
```python
# 正确示例 - 在 AI 侧实现
def my_ai_organize():
    # 1. 获取数据
    emails = mcp.call("list_emails")
    
    # 2. AI 决策
    spam = my_model.classify(emails)
    
    # 3. 执行操作
    mcp.call("delete_emails", {"email_ids": spam})
    
    # 4. AI 生成摘要
    return my_model.summarize(emails)
```

## 🚀 使用示例

### 场景 1: 智能收件箱整理

```python
# AI Agent 伪代码
async def organize_inbox():
    # 1. 获取文件夹统计（新工具）
    folders = await mcp.call("list_unread_folders")
    
    # 2. 找出未读最多的文件夹
    target = max(folders, key=lambda f: f['unread_count'])
    
    # 3. 获取该文件夹的邮件头（新工具 + 分页）
    page_size = 50
    all_headers = []
    for offset in range(0, target['unread_count'], page_size):
        emails = await mcp.call("list_emails", {
            "folder": target['name'],
            "limit": page_size,
            "offset": offset
        })
        headers = await asyncio.gather(*[
            mcp.call("get_email_headers", {"email_id": e['id']})
            for e in emails
        ])
        all_headers.extend(headers)
    
    # 4. AI 分类
    spam_ids = my_ai.classify_spam(all_headers)
    important_ids = my_ai.find_important(all_headers)
    
    # 5. 批量操作（带 dry_run）
    await mcp.call("delete_emails", {
        "email_ids": spam_ids,
        "dry_run": True  # 先验证
    })
    await mcp.call("delete_emails", {
        "email_ids": spam_ids,
        "dry_run": False  # 再执行
    })
    
    # 6. 生成报告
    return {
        "processed": len(all_headers),
        "spam_deleted": len(spam_ids),
        "important": important_ids
    }
```

### 场景 2: 健康度监控

```python
async def check_email_health():
    # 使用新的 get_recent_activity 工具
    activity = await mcp.call("get_recent_activity", {
        "include_stats": True
    })
    
    issues = []
    for account in activity['accounts']:
        # AI 分析健康度
        if account['success_rate'] < 95:
            issues.append({
                "account": account['account'],
                "issue": "Low success rate",
                "rate": account['success_rate']
            })
        
        if account['last_error']:
            issues.append({
                "account": account['account'],
                "issue": account['last_error']
            })
    
    if issues:
        send_alert(issues)  # AI 决定如何告警
```

### 场景 3: 高效批量处理

```python
async def bulk_process_emails():
    # 1. 先获取邮件列表
    emails = await mcp.call("list_emails", {"limit": 100})
    
    # 2. 只获取需要的邮件头（高效）
    headers = await asyncio.gather(*[
        mcp.call("get_email_headers", {
            "email_id": e['id'],
            "headers": ["From", "Subject"]  # 只要这两个字段
        })
        for e in emails
    ])
    
    # 3. AI 快速分类（基于头部）
    to_process = my_ai.quick_filter(headers)
    
    # 4. 只获取需要处理的邮件详情
    details = await asyncio.gather(*[
        mcp.call("get_email_detail", {"email_id": h['email_id']})
        for h in to_process
    ])
    
    # 5. AI 深度处理
    return my_ai.process(details)
```

## 📊 性能优化

### 使用 get_email_headers 减少带宽

**之前**:
```python
# 获取 100 封邮件的完整内容 (~10MB)
emails = mcp.call("list_emails", {"limit": 100})
details = [mcp.call("get_email_detail", {"email_id": e['id']}) 
           for e in emails]
```

**现在**:
```python
# 只获取邮件头 (~100KB) - 节省 99% 带宽
emails = mcp.call("list_emails", {"limit": 100})
headers = [mcp.call("get_email_headers", {"email_id": e['id']}) 
           for e in emails]

# AI 筛选后只获取必要的详情
important = my_ai.filter(headers)
details = [mcp.call("get_email_detail", {"email_id": h['email_id']}) 
           for h in important]
```

### 使用分页避免超时

**之前**:
```python
# 一次获取 1000 封可能超时
emails = mcp.call("list_emails", {"limit": 1000})
```

**现在**:
```python
# 分页获取
all_emails = []
page_size = 50
for offset in range(0, 1000, page_size):
    page = mcp.call("list_emails", {
        "limit": page_size,
        "offset": offset
    })
    all_emails.extend(page['emails'])
```

## 🧪 测试建议

### 测试原子操作组合

```python
def test_organize_workflow():
    """测试整理工作流"""
    # 1. 获取文件夹
    folders = mcp.call("list_unread_folders")
    assert len(folders) > 0
    
    # 2. 获取邮件头
    emails = mcp.call("list_emails", {"limit": 5})
    headers = [mcp.call("get_email_headers", {"email_id": e['id']}) 
               for e in emails]
    assert all('From' in h['headers'] for h in headers)
    
    # 3. Dry run 删除
    result = mcp.call("delete_emails", {
        "email_ids": [emails[0]['id']],
        "dry_run": True
    })
    assert result['success']
```

## 📖 相关文档

- [MCP 设计原则](./guides/MCP_DESIGN_PRINCIPLES.md) - 核心理念
- [Scripts README](../scripts/README.md) - 示例脚本说明
- [HTTP API 快速开始](./guides/HTTP_API_QUICK_START.md) - HTTP API 部署
- [架构文档](./ARCHITECTURE.md) - 技术架构

## 🎓 学习路径

1. **理解定位** → 阅读 `MCP_DESIGN_PRINCIPLES.md`
2. **查看示例** → 阅读 `scripts/README.md` 和示例代码
3. **尝试工具** → 使用新增的三个原子工具
4. **组合使用** → 在 AI 中实现自己的整合逻辑
5. **参考优化** → 查看性能优化建议

## 💬 FAQ

### Q: 为什么要分离 AI 能力？
A: MCP 保持纯粹的数据访问层，AI 能力在上层实现，这样：
- 不同 AI 可以有不同的策略
- MCP 工具保持稳定和通用
- 用户可以选择任何 AI 模型

### Q: 示例脚本还能用吗？
A: 可以！但建议：
- 理解其逻辑后，在 AI 中复现
- 作为参考实现，而非生产依赖
- 可以复制到 `examples/` 自己定制

### Q: 如何迁移现有代码？
A: 
1. 如果直接调用 MCP 工具 → 无需改动（向后兼容）
2. 如果使用示例脚本 → 建议在 AI 中复现逻辑
3. 如果扩展了 MCP → 考虑改为 AI 层实现

### Q: 新工具的性能如何？
A: 
- `list_unread_folders`: 对每个文件夹执行 IMAP STATUS，速度较快
- `get_email_headers`: 只拉取头部，比完整邮件快 90%+
- `get_recent_activity`: 读取本地缓存，毫秒级响应

## 🔮 未来规划

### 短期
- [ ] 为新工具添加更多示例
- [ ] 完善性能基准测试
- [ ] 补充边缘情况文档

### 长期
- [ ] 考虑更多原子操作（如 `get_folder_quota`）
- [ ] 提供 OpenAPI 规范（便于自动生成客户端）
- [ ] 支持 webhook 通知（异步事件）

## 🙏 致谢

本次升级基于社区反馈和实际使用场景优化。感谢所有提供建议的用户！

---

**最后更新**: 2025-10-22  
**版本**: 1.1.0  
**工具数量**: 28 个（+3 新增，多个优化）
