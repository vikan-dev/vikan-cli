# vikan CLI

把本地代码仓库连接到 [vikan](https://app.vikan.dev)，通过 Herdr 启动 Codex、接收任务，并提交方案、文件和验证结果。

这是 `@vikan/cli` 的独立开源仓库。HTTP 协议、运行时校验和设备客户端来自 [vikan SDK](https://github.com/vikan-dev/vikan-sdk) 的 `@vikan/sdk/agent`；本仓库负责命令行、本地状态、任务恢复、Herdr 执行适配和终端预览。使用线上 vikan 服务不需要部署 API 或数据库。

<a id="installation"></a>

## 安装

需要 Bun 1.4.2 或更高版本。当前通过 Git 安装，**尚未发布到 npm**。

```sh
git clone https://github.com/vikan-dev/vikan-cli.git
cd vikan-cli
bun install --frozen-lockfile
bun run build
bun link
vikan --version
vikan --help
```

`bun link` 注册 `vikan` 命令，入口为 `src/index.ts`，可直接运行已安装依赖的源码。也可以在仓库目录运行 `bun run src/index.ts --help`；构建后的 `dist/index.js` 是带 Bun shebang 的独立文件，可复制到其他目录后执行 `bun /path/to/index.js --help`。在安装目录运行 `bun unlink` 可取消链接。

`connect` 支持 Linux 和 macOS，需要已安装 Herdr、已完成配置和登录的 Codex，并从 Herdr pane 中启动。Codex 使用你本地的模型、reasoning、sandbox 和 approval 配置。`--help`、`--version` 和本地 `render-plan` 不需要 Herdr 或 vikan 账号。

## 连接项目

在 Herdr 中进入要连接的代码仓库：

```sh
cd /path/to/your/project
vikan doctor
vikan connect
```

首次连接会显示浏览器验证地址和配对码。在浏览器中登录 vikan，确认配对码并选择 workspace/project，CLI 随后保存绑定并连接 runner。浏览器未能自动打开时，复制终端中的链接即可。已绑定目录再次运行 `vikan connect` 会恢复连接，并核对未完成任务。

runner 在自己创建的相邻 Herdr pane 中启动 Codex，向 vikan 发送任务回执和该 pane 的可见终端画面。Ctrl-C 停止 runner；退出不会自动关闭已有任务 pane。对于无法确认是否已经送达的提示或执行结果，CLI 保留 journal 以便恢复，不自动重发。更新 CLI 后停止 runner，再在相同目录执行 `vikan connect`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `vikan` / `vikan connect` | 配对当前目录（如需要），连接并恢复 runner。 |
| `vikan link` | 仅完成浏览器配对，需要 Herdr pane。 |
| `vikan status` | 查看目录绑定、连接和服务端确认状态；可以在 Herdr 外执行。 |
| `vikan doctor` | 检查 Bun、Herdr、Codex、配置和网络；在 Herdr 外会报告 pane 检查失败。 |
| `vikan unlink` | 撤销目录绑定并移除本地凭据；存在未完成任务时拒绝解绑，网络失败不算撤销成功。 |
| `vikan deliverables <command>` | 渲染方案，或从当前任务提交文档、文件和验证结果。 |
| `vikan --help` / `vikan --version` | 查看帮助或版本，不发起连接或配对。 |

### 方案与交付材料

本地生成可离线打开的 HTML 方案：

```sh
vikan deliverables render-plan --help
vikan deliverables render-plan --source ./plan.md --output ./plan.html
vikan deliverables render-plan --licenses
```

渲染只需要 Bun 和 Markdown 源文件；渲染器及其许可证已随 CLI 打包。`render-plan --help` 列出支持的 Markdown 和图表语法。

`context`、`publish-stage`、`upload`、`finish-stage`、`status`、`retry` 等交付命令使用当前任务的设备凭据和 runner journal。网络提交需要在任务所属的 Herdr pane 和已配对目录中执行。任务提示会提供准确的 CLI 调用方式；`--run` 用于核对任务身份，本身不授予权限。完整示例、回执处理和退出码见 [DELIVERABLES.md](DELIVERABLES.md)。

## 配置与本地数据

| 环境变量 | 用途 |
| --- | --- |
| `VIKAN_API_URL` | 首次配对的 API origin，默认 `https://app.vikan.dev`；已绑定目录恢复时使用保存的 origin。 |
| `VIKAN_CONFIG_DIR` | 本地状态目录，默认 `~/.config/vikan`。 |
| `HERDR_ENV`、`HERDR_SOCKET_PATH` | Herdr 提供的会话信息；CLI 会向运行中的 Herdr 核对真实 pane 身份。 |

设备凭据由 CLI 随机生成，通过浏览器配对取得当前账号和项目的授权；这里使用的是 SDK agent 设备认证流程，不是 SDK 主入口的 API key。S2 命令流和终端画面使用服务端签发的短期 stream token，用户无需配置 S2 主密钥。

绑定、设备凭据、恢复 journal 和交付材料回执保存在配置目录，并按 API origin 与账号隔离。凭据和交付输入使用仅当前用户可读写的文件权限。CLI 不向你的项目写入凭据，也不修改项目 `AGENTS.md` 或 Codex 全局配置。终端预览会上传运行 pane 的可见内容，交付命令会上传明确指定的文件。

目录执行锁与恢复归属另存于系统账号 home 下的 `~/.local/state/vikan/directories`，不随 `VIKAN_CONFIG_DIR`、API origin 或账号变化。若提示 checkout 仍有未完成的恢复状态，请使用提示中的原配置目录和绑定运行 `vikan connect`，完成恢复后再切换；不要直接删除锁文件或 `.owner.json`。runner 退出会释放内核锁，恢复记录则保留用于核对已有任务。

## 开发

```sh
bun install --frozen-lockfile
bun run check
```

`check` 运行 typecheck、独立进程单测、构建和仓库外 bundle smoke。单测使用 fake API、Herdr 和 S2，不要求数据库、真实账号或私有仓库访问权限。SDK 依赖固定到公开 Git 仓库的完整 commit SHA，协议更新通过 SDK 完成。详细说明见 [TESTING.md](TESTING.md)，维护与发布步骤见 [PUBLISHING.md](PUBLISHING.md)。

本仓库代码采用 [MIT License](LICENSE)。内置 renderer 的完整许可证和依赖 notices 保存在 [vendor/answer-me-with-html](vendor/answer-me-with-html/README.md)，其他来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
