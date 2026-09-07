# 邮件本地数据库设计方案 (Legacy)

## 概述

为了提升 mail-use CLI 的性能，我们将实现本地 SQLite 数据库来缓存邮件数据。

注：本文档源自旧实现时期，作为设计参考保留。

## 设计原则

1. **性能优先** - 快速查询和搜索
2. **隐私保护** - 敏感数据可选存储
3. **增量同步** - 只同步变化的数据
4. **离线支持** - 本地操作不依赖网络
5. **扩展性** - 支持未来功能扩展

## 数据库架构

### 1. 账户表 (accounts)
```sql
CREATE TABLE accounts (
    id TEXT PRIMARY KEY,              -- 账户唯一ID
    email TEXT NOT NULL UNIQUE,       -- 邮箱地址
    provider TEXT NOT NULL,           -- 提供商 (163/gmail/qq/outlook/custom)
    is_default BOOLEAN DEFAULT 0,     -- 是否默认账户
    last_sync_time DATETIME,          -- 最后同步时间
    sync_status TEXT,                 -- 同步状态 (syncing/completed/failed)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2. 文件夹表 (folders)
```sql
CREATE TABLE folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    folder_name TEXT NOT NULL,        -- IMAP文件夹名
    display_name TEXT,                -- 显示名称（处理UTF-7编码）
    parent_folder TEXT,               -- 父文件夹
    level INTEGER DEFAULT 0,          -- 层级深度
    message_count INTEGER DEFAULT 0,  -- 邮件总数
    unread_count INTEGER DEFAULT 0,   -- 未读数
    last_sync_uid INTEGER,            -- 最后同步的UID
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    UNIQUE(account_id, folder_name)
);
```

### 3. 邮件元数据表 (emails)
```sql
CREATE TABLE emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    folder_id INTEGER NOT NULL,
    uid INTEGER NOT NULL,             -- IMAP UID
    message_id TEXT,                  -- Message-ID header
    subject TEXT,
    from_address TEXT,
    from_name TEXT,
    to_addresses TEXT,                -- JSON array
    cc_addresses TEXT,                -- JSON array
    date DATETIME,
    size INTEGER,
    is_read BOOLEAN DEFAULT 0,
    is_flagged BOOLEAN DEFAULT 0,
    is_deleted BOOLEAN DEFAULT 0,
    has_attachments BOOLEAN DEFAULT 0,
    preview TEXT,                     -- 前100字预览
    labels TEXT,                      -- JSON array (for Gmail)
    sync_status TEXT DEFAULT 'meta',  -- meta/full/error
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (folder_id) REFERENCES folders(id),
    UNIQUE(account_id, folder_id, uid)
);

-- 索引优化查询性能
CREATE INDEX idx_emails_account_folder ON emails(account_id, folder_id);
CREATE INDEX idx_emails_date ON emails(date DESC);
CREATE INDEX idx_emails_from ON emails(from_address);
CREATE INDEX idx_emails_unread ON emails(is_read, date DESC);
CREATE INDEX idx_emails_flagged ON emails(is_flagged);
```

### 4. 邮件内容表 (email_contents)
```sql
CREATE TABLE email_contents (
    email_id INTEGER PRIMARY KEY,
    body_text TEXT,                   -- 纯文本内容
    body_html TEXT,                   -- HTML内容
    headers TEXT,                     -- JSON格式的邮件头
    raw_size INTEGER,                 -- 原始邮件大小
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);
```

### 5. 附件表 (attachments)
```sql
CREATE TABLE attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT,
    size INTEGER,
    content_id TEXT,                  -- For inline attachments
    is_inline BOOLEAN DEFAULT 0,
    file_path TEXT,                   -- 本地存储路径（可选）
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);
```

### 6. 搜索索引表 (使用FTS5)
```sql
CREATE VIRTUAL TABLE email_search USING fts5(
    email_id,
    subject,
    from_address,
    from_name,
    body_text,
    content='emails',
    content_rowid='id'
);

-- 触发器保持索引同步
CREATE TRIGGER emails_ai AFTER INSERT ON emails BEGIN
    INSERT INTO email_search(email_id, subject, from_address, from_name)
    VALUES (new.id, new.subject, new.from_address, new.from_name);
END;
```

### 7. 同步日志表 (sync_log)
```sql
CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    folder_id INTEGER,
    sync_type TEXT,                   -- full/incremental/delete
    start_time DATETIME,
    end_time DATETIME,
    emails_synced INTEGER DEFAULT 0,
    emails_deleted INTEGER DEFAULT 0,
    status TEXT,                      -- success/failed/partial
    error_message TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (folder_id) REFERENCES folders(id)
);
```

## 同步策略

### 1. 初始同步
- 获取所有文件夹结构
- 每个文件夹获取最近30天的邮件元数据
- 标记重要邮件（未读、已加星标）进行全文同步

### 2. 增量同步
- 使用IMAP UID跟踪变化
- 每个文件夹记录last_sync_uid
- 只同步UID大于last_sync_uid的新邮件
- 定期检查已同步邮件的标记变化

### 3. 同步优先级
1. 默认账户的INBOX
2. 其他账户的INBOX
3. 未读邮件较多的文件夹
4. 其他文件夹

### 4. 存储策略
- 元数据：始终存储
- 邮件正文：可配置（默认存储最近7天）
- 附件：只存储元数据，按需下载

## API设计

### 数据库管理类
```python
class EmailDatabase:
    def __init__(self, db_path: str = "~/.local/share/mailbox/email_sync.db"):
        self.db_path = os.path.expanduser(db_path)
        self.init_database()
    
    def init_database(self):
        """初始化数据库结构"""
        pass
    
    def sync_account(self, account_id: str, full_sync: bool = False):
        """同步指定账户"""
        pass
    
    def search_emails(self, query: str, account_id: Optional[str] = None):
        """全文搜索邮件"""
        pass
    
    def get_email_list(self, account_id: Optional[str] = None, 
                      folder: Optional[str] = None,
                      unread_only: bool = False,
                      limit: int = 50):
        """获取邮件列表"""
        pass
    
    def get_email_detail(self, email_id: int):
        """获取邮件详情"""
        pass
    
    def mark_email(self, email_id: int, is_read: bool):
        """标记邮件（需要同步到服务器）"""
        pass
```

## 性能优化

1. **批量操作** - 使用事务批量插入/更新
2. **连接池** - 复用数据库连接
3. **索引优化** - 针对常用查询创建索引
4. **分页查询** - 避免一次加载过多数据
5. **异步同步** - 后台线程进行同步

## 隐私和安全

1. **数据加密** - 敏感字段可选加密存储
2. **自动清理** - 定期清理过期数据
3. **权限控制** - 数据库文件权限设置为600
4. **匿名化** - 日志中不记录邮件内容

## 迁移计划

### 第一阶段：基础实现
1. 实现数据库结构和基础API
2. 实现邮件元数据同步
3. 修改list_emails使用本地数据

### 第二阶段：完整功能
1. 实现全文搜索
2. 实现增量同步
3. 添加同步调度器

### 第三阶段：优化提升
1. 实现智能缓存策略
2. 添加性能监控
3. 优化查询性能

## 配置选项

```python
DATABASE_CONFIG = {
    "db_path": "~/.local/share/mailbox/email_sync.db",
    "sync_interval": 300,  # 5分钟
    "max_body_days": 7,    # 保存最近7天的邮件正文
    "max_db_size": 1024,   # MB
    "enable_fts": True,    # 启用全文搜索
    "auto_cleanup": True,  # 自动清理
}
```
