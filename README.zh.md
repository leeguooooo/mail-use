# mail-use

给 AI agent 用的邮箱命令行。一个命令管 Gmail、QQ、163、Outlook 和任意 IMAP/SMTP 账号，
输出全是 JSON；会改动邮箱的命令默认只出预览，不加 `--confirm` 什么都不动。

```bash
mail-use code --json          # 最新的验证码，一趟实时拉取
mail-use email recent --format compact --json
mail-use email delete --from newsletter@shop.com --confirm --json
```

属于 [`*-use` 家族](#-use-家族)，这些工具各自把 agent 的手伸到一个真实的东西上。

### 为什么不自己写段 IMAP 脚本

- **输出是稳定的 JSON 契约，不是给人读的文本。** 每个响应都带 `success`，失败带
  `error_code`，取值来自固定的一组（`auth_failed`、`folder_not_found`、`imap_error` 等）。
  契约写在 [`docs/CLI_JSON_CONTRACT.md`](docs/CLI_JSON_CONTRACT.md)。
- **它会告诉你什么时候可能不准。** 走缓存的读取会报 `from_cache`、`cache_age_seconds`、
  `cache_stale`；快照旧到说明同步已经停了，它就拒绝拿这份数据回答，改走实时 IMAP。
  空收件箱不会被当成"确实没新邮件"。
- **删和发要你点头。** `delete` / `mark` / `move` / `send` 先返回预览，按账号和文件夹分组，
  附样本主题，加 `--confirm` 才动手。`--all-folders` 默认跳过已发送、草稿、垃圾邮件、废纸篓。
- **为 token 预算做过取舍。** `--format compact` 只留十个值得扫的字段，20 封邮件从
  8846 字节降到 6189。`--with-preview` 让列表一趟带回正文片段。批量 `show` 复用一条 IMAP 连接。
- **快到可以放进循环里调。** 常驻 daemon 池化 IMAP 连接，后台同步到本地 SQLite，
  连续五次 `email list` 从 25 秒降到 0.83 秒。
- **也能走 MCP。** `mail-use mcp config --json` 打印可直接粘贴的配置，server 暴露 16 个工具，
  dry-run 的默认行为一致。

> 本项目原名 **Mailbox**，现改名 **mail-use**。命令换成 `mail-use`，旧的 `mailbox` 仍然可用；
> `~/.config/mailbox` 下的账号配置和缓存数据库不动。

## 支持的邮箱

163 / 126、QQ、Gmail、Outlook / Hotmail，以及任意自建 IMAP+SMTP。

搜索在各家的行为不一样，CLI 会照实说明：Gmail 走 `X-GM-RAW`，正文由服务端搜；
QQ、163、Outlook 的 IMAP TEXT 搜索是坏的，`--query` 只能退化成匹配主题和发件人。
在这几家用 `--from` / `--subject` 结果才可预期。

## 安装

### 一行 curl

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/mail-use/main/install.sh | sh
mail-use --help
```

从 [GitHub Release](https://github.com/leeguooooo/mail-use/releases/latest) 拉对应平台的二进制
（macOS arm64/x64、Linux x64），校验 sha256 后装到 `~/.local/bin`。锁版本用
`MAIL_USE_VERSION=v2.11.2`，换目录用 `MAIL_USE_INSTALL_DIR=...`。

没有 npm 包。只走 GitHub Release 二进制：发版不用 `NPM_TOKEN` 和 2FA，
装的人也不需要 Node。改名前的 `@leeguoo/mailbox-cli` 停在旧版本，不再更新。

### 升级

```bash
mail-use upgrade --check        # 有没有新版本
mail-use upgrade                # 下载、校验 sha256、原地替换、重启 daemon
mail-use upgrade --tag v3.1.0   # 装指定版本（回滚也走这个）
```

daemon 在跑的时候会替你留意新版本：每天一次对 GitHub releases API 的匿名 GET
（`MAILBOX_UPDATE_CHECK_HOURS`，设 `0` 关闭），结果出现在
`mail-use daemon status --json` 的 `update` 字段。它只报告，不下载也不安装。

`upgrade` 不会自动执行，也不会自己在后台跑：一个悄悄替换自身可执行文件的工具是供应链
意外，不是便利。校验和跟发布的 `.sha256` 对不上就拒绝安装；在源码检出里直接拒绝运行
（那里的 `process.execPath` 是你的 `node`）。重跑 `curl … install.sh | sh` 效果一样。

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
# 全部账号里最新的验证码，一趟实时拉取
mail-use code --json

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


## 常驻 daemon（CLI 调用快 5-30 倍）

不开 daemon 时，每次调用都要花 1-3 秒在 TCP+TLS+IMAP LOGIN 上。开了之后调用复用连接池，
后台还会同步到本地 SQLite，`email list` 通常压根不碰 IMAP。

`curl … install.sh | sh` 在已经配好账号时会自动装（设 `MAIL_USE_NO_DAEMON=1` 可跳过）。
其他情况手动装：

```bash
mail-use daemon install      # 开机自启（macOS launchd / Linux systemd-user）
mail-use daemon status --json
mail-use daemon reload       # 改完 auth.json 后丢弃连接池
```

实测环境：Gmail 收件箱，M2 MacBook，家用宽带。

| 操作 | 无 daemon | daemon（`--live`） | daemon（走缓存） |
|---|---|---|---|
| 单次 `email list` | 5.0s | 1.0s | 0.17s |
| `email folders` | 5.0s | 0.85s | n/a |
| 连续 5 次 `email list` | 25s | 5.3s | **0.83s** |
| 并发 3 次 `email show` | ~15s | 2.7s | **0.88s** |

### 资源占用（一台机器上跑很多 agent session）

daemon 是**每个用户一个进程**，所有 agent session 通过 Unix socket 共用它，所以
session 变多不会让 IMAP 连接变多。macOS 上连着 3 个账号时的实测空闲值：

| | |
|---|---|
| 空闲 CPU | 约 0.15% |
| 空闲 RSS | 3-15 MB |
| 连接数 | 每账号最多 3 条（`MAILBOX_POOL_MAX`），空闲 10 分钟后回收到 1 条 |
| 12 个并发调用 | 1.6 秒跑完，连接池每账号仍只用 1 条 |

默认值不合适时可以调：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `MAILBOX_POOL_MAX` | `3` | 每账号并发 IMAP 连接上限 |
| `MAILBOX_POOL_IDLE_MS` | `600000` | 空闲多久回收连接（`0` 关闭回收） |
| `MAILBOX_POOL_KEEP_WARM` | `1` | 回收时每账号保留几条热连接 |
| `MAILBOX_NO_DAEMON` | 未设置 | 设为 `1` 让 CLI 完全跳过 daemon |
| `MAILBOX_UPDATE_CHECK_HOURS` | `24` | daemon 的被动版本检查（`0` 关闭） |

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
