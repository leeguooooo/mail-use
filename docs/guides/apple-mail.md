# mail-use 和苹果「邮件」互通

mail-use 给 AI 用，「邮件」给人用。两边连的是同一个邮箱服务器，账号配一次就够了：已读、移动、删除会自动同步，不用在两边各操作一遍。

| 你现在的情况 | 运行 |
|---|---|
| 不知道两边各有哪些账号 | `mail-use apple-mail status` |
| 账号在 mail-use 里，想在「邮件」里看 | `mail-use apple-mail` |
| 账号在「邮件」里，想让 AI 也能用 | `mail-use apple-mail import` |
| 两边都还没有 | `mail-use account add`，再运行 `mail-use apple-mail` |

## 先看两边各有什么

```bash
mail-use apple-mail status
```

它会列出每个邮箱在 mail-use 和「邮件」里各有没有，以及该运行哪条命令补齐。

第一次运行时，macOS 会弹窗问「"终端"想要控制"邮件"」，点 **允许**。mail-use 只读取账号名和服务器地址，读不到你的密码，也不会改「邮件」里的任何东西。

## 把 mail-use 的账号加到「邮件」

```bash
mail-use apple-mail
```

运行后：

1. 系统设置会自动打开到「设备管理」页面。
2. 双击 **mail-use 邮箱账号**，点 **安装**，输入开机密码。
3. 打开「邮件」，账号已经在里面了，服务器、端口、授权码都不用填。

**请在 5 分钟内点安装。** macOS 会在几分钟后自动丢掉没安装的描述文件，过期了就重新运行一次命令。

「邮件」里已经有的邮箱会被跳过。比如你在「邮件」里用 Google 登录过 Gmail，这次就不会再加一个重复的 Gmail。

**装到 iPhone 或 iPad：**

```bash
mail-use apple-mail --output ~/Desktop/邮箱.mobileconfig --no-open
```

用隔空投送把桌面上的文件发到手机，在手机的「设置」里点「已下载描述文件」安装。装完把电脑和手机上的这个文件都删掉，因为它里面是明文授权码。

**以后想从「邮件」里删掉这些账号：** 系统设置 → 通用 → 设备管理 → mail-use 邮箱账号 → 移除。

### 为什么不能一条命令全自动装好

从 macOS 11 开始，苹果只允许在系统设置里由本人点击安装描述文件，任何程序都绕不过去。mail-use 能做的是把文件准备好、把系统设置翻到正确的页面，最后那一下要你来点。

## 把「邮件」的账号加到 mail-use

```bash
mail-use apple-mail import
```

mail-use 会读出「邮件」里有、mail-use 里没有的邮箱，服务器设置自动带过来。每个邮箱只需要你粘贴一次**授权码**（有的服务商叫「应用专用密码」）。粘贴时屏幕上不显示字符，粘完按回车。mail-use 会先试着连一次，连得上才保存。

只导入某一个邮箱：

```bash
mail-use apple-mail import --email you@qq.com
```

### 为什么还要再粘一次授权码

「邮件」里的密码由 macOS 保管，别的程序读不到，这是苹果的安全设计。用 Google 账号登录的 Gmail 更特殊：「邮件」里根本没有密码，用的是只有苹果能用的 Google 登录凭证。所以 mail-use 需要你单独生成一个授权码。

授权码不是你的登录密码，是邮箱服务商专门给第三方程序用的一串字符。在哪里生成：

| 邮箱 | 去哪里拿 |
|---|---|
| QQ 邮箱 | 网页版 [wx.mail.qq.com](https://wx.mail.qq.com) → 设置 → 账号与安全 → 安全设置 → 开启 IMAP/SMTP 服务，按提示生成授权码 |
| 163 / 126 邮箱 | 网页版 [mail.163.com](https://mail.163.com) 或 [mail.126.com](https://mail.126.com) → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 新增授权密码 |
| Gmail | 先在 Google 账号里开启两步验证，再到 [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) 生成应用专用密码 |
| iCloud 邮箱 | 先给 Apple 账号开启双重认证，再到 [account.apple.com](https://account.apple.com) → 登录与安全 → App 专用密码 |
| Outlook / Hotmail | 微软已不再允许个人账号用密码登录 IMAP，暂不支持 |

命令运行时也会在屏幕上给出对应邮箱的链接和步骤，照着做就行。

## 两边都还没有账号

```bash
mail-use account add
```

按提示输入邮箱地址，再粘贴授权码。服务器设置按邮箱后缀自动识别（QQ、163、126、Gmail、iCloud），连接测试通过后保存。之后运行 `mail-use apple-mail`，同一个账号也就进了「邮件」。

## 常见问题

**系统设置里找不到「mail-use 邮箱账号」。** 描述文件过期了，重新运行 `mail-use apple-mail`，在 5 分钟内点安装。

**「邮件」里出现了两个一样的邮箱。** 在系统设置 → 通用 → 设备管理里移除「mail-use 邮箱账号」即可。`mail-use apple-mail` 默认会跳过「邮件」里已有的邮箱，加了 `--include-existing` 才会重复。

**点了「不允许」，之后 status / import 一直失败。** 系统设置 → 隐私与安全性 → 自动化 → 终端，打开「邮件」的开关。

**import 提示授权码不对。** 授权码要在网页版邮箱里生成，复制时不要带空格。QQ 和 163 的授权码在生成页面只显示一次，忘了就再生成一个新的。

**我的授权码存在哪里。** 存在 `~/.config/mailbox/auth.json`，只有你自己的账户能读。装到「邮件」时临时生成的描述文件，打开 60 秒后会自动删除。
