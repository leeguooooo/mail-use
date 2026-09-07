# mail-use CLI

以 CLI 为核心的多邮箱（IMAP/SMTP）管理工具，支持本地同步缓存（SQLite）。

主入口：`mail-use` CLI（Node.js 实现），按平台分发预编译二进制，装完即用，不需要 Python。

> 本项目原名 **Mailbox**，现改名 **mail-use**。命令换成 `mail-use`，旧的 `mailbox` 仍然可用；
> `~/.config/mailbox` 下的账号配置和缓存数据库不动。

## 安装

### 一行 curl（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/mail-use/main/install.sh | sh
mail-use --help
```

从 [GitHub Release](https://github.com/leeguooooo/mail-use/releases/latest) 拉对应平台的二进制
（macOS arm64/x64、Linux x64），校验 sha256 后装到 `~/.local/bin`。锁版本用
`MAIL_USE_VERSION=v2.11.2`，换目录用 `MAIL_USE_INSTALL_DIR=...`。

### npm

```bash
npm install -g @leeguoo/mail-use
```

同一份二进制，通常比 GitHub Release 慢一步。

### 装成 AI Skill（Claude Code / Cursor 等）

```bash
# 项目级，装到 ./.claude/skills/mail-use
npx skills add leeguooooo/mail-use --skill mail-use

# 用户级，装到 ~/.claude/skills/mail-use
npx skills add leeguooooo/mail-use --skill mail-use -g
```

Skill 默认 `mail-use` 已在 PATH 上，所以先跑上面的 curl 安装。想再快 5-30 倍就装常驻进程：
`mail-use daemon install`。

### MCP server

```bash
mail-use mcp config --json   # 打印可直接粘贴的 mcpServers 配置
```

### 从源码开发

```bash
pnpm install
pnpm test
pnpm build:binary
```

## 配置邮箱

```bash
mkdir -p ~/.config/mailbox
cp examples/accounts.example.json ~/.config/mailbox/auth.json
```

配置文件位置：

- 认证信息：`~/.config/mailbox/auth.json`
- 其他配置：`~/.config/mailbox/config.toml`

## 常用命令

```bash
# 交互式
mail-use

# 列出账户
mail-use account list --json

# 列出未读邮件（默认优先缓存；--from 缓存侧按发件人过滤）
mail-use email list --unread-only --limit 20 --json
mail-use email list --account-id my_account_id --from "newsletter" --json

# 查看邮件详情（响应包含 list_unsubscribe，方便一键退订）
mail-use email show 123456 --account-id my_account_id --json

# 标记已读（建议先 dry-run）
mail-use email mark 123456 --read --account-id my_account_id --folder INBOX --dry-run --json
mail-use email mark 123456 --read --account-id my_account_id --folder INBOX --confirm --json

# 按发件人/主题批量操作（无需先查 UID）
mail-use email mark --from "support@npmjs.com" --read --confirm --account-id my_account_id --json
mail-use email delete --from "newsletter" --account-id my_account_id --json   # 不带 --confirm 是 dry-run 预览
mail-use email delete --subject "[ad]" --account-id my_account_id --confirm --json

# 连接测试
mail-use account test-connection --json
```

## `*-use` 家族

一组小而互相独立的 CLI，各自把 agent 的手伸到一个真实的东西上。装法都一样：
`curl … install.sh | sh` 装命令，`npx skills add leeguooooo/<name>` 教会 agent，输出都是 JSON。

| 仓库 | 给 agent 的能力 |
|---|---|
| [chrome-use](https://github.com/leeguooooo/chrome-use) | 一个真浏览器：带登录态操作、填表、抓数据、截图 |
| [mail-use](https://github.com/leeguooooo/mail-use) | 邮箱：读、搜、发、清理，Gmail / QQ / 163 / 任意 IMAP |
| [iphone-use](https://github.com/leeguooooo/iphone-use) | 一台真 iPhone：点按、输入、截屏、导出手机上的数据 |
| [wechat-use](https://github.com/leeguooooo/wechat-use) | macOS 微信：发消息、查联系人和聊天记录 |
| [discord-use](https://github.com/leeguooooo/discord-use) | Discord：消息、频道、论坛、webhook（纯 REST，Rust） |
| [cookie-use](https://github.com/leeguooooo/cookie-use) | 同一站点的多个登录态：抓取、切换、注入 |
| [profile-use](https://github.com/leeguooooo/profile-use) | 本地个人资料：安全地填注册 / KYC / 结账表单 |
| [bitwarden-use](https://github.com/leeguooooo/bitwarden-use) | Bitwarden / Vaultwarden：无头 passkey（FIDO2）登录 |
| [chatgpt-use](https://github.com/leeguooooo/chatgpt-use) | 把 ChatGPT 订阅当成编码 agent 的后端，不用 API key |
| [computer-use](https://github.com/leeguooooo/computer-use) | macOS 桌面本身 |
| [pixcake-use](https://github.com/leeguooooo/pixcake-use) | 只读探查 PixCake：快照 / diff / SQLite 检查 |


## AI 集成说明

- `docs/AI_SKILL_MAIL_USE.md`

## OpenClaw 集成

本仓库包含 OpenClaw 技能：`skills/mail-use/SKILL.md`。

OpenClaw 默认加载以下目录的技能：
- `<workspace>/skills`
- `~/.openclaw/skills`

快速链接脚本（将仓库 skill 软链到 `~/.openclaw/skills`）：

```bash
./scripts/link_openclaw_skill.sh
```

如需覆盖已有链接：

```bash
./scripts/link_openclaw_skill.sh --force
```

如需直接引用本仓库的技能目录，可在 `~/.openclaw/openclaw.json`
中添加 `skills.load.extraDirs`：

```json
{
  "skills": {
    "load": {
      "extraDirs": [
        "/path/to/mcp-email-service/skills"
      ]
    }
  }
}
```

OpenClaw 负责渠道投递与定时调度；mail-use 只输出结构化 JSON 与可选摘要文本。

验证 OpenClaw 是否加载成功：

```bash
openclaw skills list --eligible
openclaw skills check
```
