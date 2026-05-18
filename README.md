# oh-my-wechat

`oh-my-wechat` 用来把微信消息桥接到本地 CLI agent。你可以在微信里远程驱动本机的 `Codex`、`Claude Code`、`OpenCode`，或者一个持久 shell，并把结果、附件和审批流再回到微信。

## 主要能力

- 在微信里给本地 agent 发消息并接收结果
- 支持 `Codex` / `Claude Code` / `OpenCode` / `shell` 四种模式
- 支持远程审批：在微信里直接 `/yes`、`/no`
- 支持把本地图片、视频、文件、语音上传并发回微信
- 支持把微信里的图片、视频、文件传给 agent 使用
- 本地终端可实时显示执行过程、时间戳与颜色区分
- 单活 bridge：同一时间只保留一个活动 bridge，避免串线

## 环境要求

- Node.js `>= 20.11.0`
- 本机已安装并可使用目标 CLI，例如：`codex`、`claude`、`opencode`

## 安装

全局安装：

```bash
npm install -g oh-my-wechat
```


从源码安装：

```bash
npm install
npm run build
npm link
```

## 登录

首次使用先执行：

```bash
omw setup
```

登录信息会保存在：

- `~/.oh-my-wechat/account.json`

如需重新登录：

```bash
omw setup --force
```

## 快速开始

进入你希望 agent 操作的项目目录，然后启动一个模式：

```bash
omw codex
omw claude
omw opencode
omw shell
```

通用写法：

```bash
omw bridge --mode codex --cwd /path/to/project
omw bridge --mode shell --command "pwsh"
```

启动后：

1. bridge 会开始轮询微信消息
2. 你在微信里发普通消息，bridge 会转给当前 agent
3. agent 的最终结果会回到微信
4. 本地终端会实时显示接收文案和执行过程

## 模式说明

### `omw codex`

- 通过 `codex app-server` + WebSocket RPC 接入
- 支持远程审批
- 支持本地终端实时显示中间输出
- 适合代码、文件、命令、多步任务

### `omw claude`

- 通过 `claude -p --output-format json` 接入
- 支持远程审批
- 主要返回最终答复和审批信息

### `omw opencode`

- 通过 `opencode serve` + SDK / event stream 接入
- 支持远程审批
- 主要返回最终答复

### `omw shell`

- 用于远程执行本地 shell 命令
- 高危命令会要求审批
- 交互式程序会被拦截

## 微信侧控制命令

在微信里可用：

```text
/help
/status
/stop
/reset
/yes
/no
```

含义：

- `/help`：查看帮助
- `/status`：查看当前 bridge / agent 状态
- `/stop`：中断当前任务
- `/reset`：重启当前本地 agent
- `/yes`：同意当前审批
- `/no`：拒绝当前审批

## 远程审批

如果 agent 需要执行敏感操作，bridge 会把审批提示发到微信。

你只需要在微信里回复：

```text
/yes
```

或：

```text
/no
```

当前支持远程审批的典型场景：

- `Codex` 请求继续执行某个操作
- `Claude Code` 请求工具权限
- `OpenCode` 请求 permission
- `shell` 模式执行高危命令

## 附件能力

### 微信 -> agent

当前支持把微信里的这些附件传给 agent：

- image
- video
- file
- voice

其中图片、视频、文件会尽量落到本地工作区，供 agent 直接使用。

### agent -> 微信

如果 agent 知道本地文件的绝对路径，并输出附件 marker，`oh-my-wechat` 会自动上传并发回微信。

支持的 marker：

```text
[[file:/absolute/path/report.pdf]]
[[image:/absolute/path/screenshot.png]]
[[video:/absolute/path/demo.mp4]]
[[voice:/absolute/path/audio.m4a]]
```

### 自然语言发送附件

现在你可以直接在微信里对 agent 说：

```text
把这个图片发我
这个视频传我
把刚才那个 PDF 发给我
通过网桥发过来
```

桥接层会尽量把这类请求理解成：

- 优先直接上传附件
- 少发解释性废话
- 不再要求你手动去微信里选文件

### 附件发送注意事项

- 路径必须是**绝对路径**
- 文件必须在本地**真实存在**
- bridge 会根据扩展名自动判断 `image / video / voice / file`

## 本地终端显示

启动 `omw codex` / `omw claude` / `omw opencode` / `omw shell` 后，本地终端会显示运行日志。

当前行为：

- 所有日志带时间戳
- 微信来消息：青色
- agent 实时输出：绿色
- 系统日志：灰色
- 仅在 TTY 下启用颜色；如设置 `NO_COLOR` 则自动关闭颜色

注意：

- 实时过程显示在**本地终端**
- 微信侧主要接收最终结果、审批提示和附件

## 微信文本回复格式

所有发到微信的文本，都会自动在第一行带上时间：

```text
2026年05月18日 21:34:56
这里是正文
```

图片、视频、文件、语音不受这个规则影响。

## shell 模式的安全规则

`shell` 模式下会阻止一些明显不适合远程执行的操作。

高危命令会要求审批，例如：

- `rm -rf`
- `sudo`
- `git reset --hard`
- `git clean -fd`
- `shutdown`
- `reboot`
- `mkfs`

交互式程序会被拦截，例如：

- `vim`
- `nano`
- `less`
- `top`
- `ssh`

## 常见问题

### 1. 为什么没有回微信？

先在微信里发送：

```text
/status
```

检查当前 bridge 是否在线、agent 是否在忙、是否卡在审批。

### 2. 为什么提示没有可回复的上下文？

说明当前用户最近没有新的微信上下文。让对方先再发一条消息，再重试。

### 3. 为什么附件没有发出去？

优先检查：

- 路径是不是绝对路径
- 文件是不是确实存在
- 文件大小是否超出限制
- agent 是否输出了正确的 marker 或可识别路径

### 4. 为什么本地只保留一个 bridge？

当前是单活模型。新 bridge 启动时会尝试停掉旧 bridge，避免多实例串消息、抢上下文。

## 本地状态目录

`oh-my-wechat` 会在 `~/.oh-my-wechat/` 下保存运行状态：

- `account.json`：登录信息
- `sync-cursor.txt`：微信增量游标
- `reply-contexts.json`：回复上下文
- `active-bridge-lock.json`：活动 bridge 锁
- `codex-runtime/`：Codex runtime endpoint 信息

## 开发

类型检查：

```bash
npm run check
```

构建：

```bash
npm run build
```

本地源码运行：

```bash
npm run codex
npm run claude
npm run opencode
npm run shell
```

## 发布前检查

```bash
npm run check
npm run build
npm pack --dry-run
npm publish --access public
```
