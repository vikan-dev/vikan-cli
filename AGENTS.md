# AGENTS.md

## 项目边界

- 品牌和产品名使用小写 **vikan**，包名为 `@vikan/cli`，环境变量前缀为 `VIKAN_*`。外部工具 Herdr、Codex、S2 使用各自真实名称。
- 默认 `README.md` 使用英文；中文说明维护在 `README.zh-CN.md`，两份文档标题下保留双向语言导航，更新使用说明时同步两种语言。
- 本仓库是独立 CLI。HTTP 协议、字段 schema、设备客户端及协议 helper 以公开 `@vikan/sdk/agent` 为唯一来源，不手抄 URL、请求/响应定义或复制私有 contract 源码。
- SDK 缺少协议能力时先在 SDK/contract 的维护流程中补齐并验证，更新公开 SDK 后，再将 CLI 的 SDK Git 依赖固定到完整 commit SHA，执行 `bun install` 更新锁文件。不要依赖 workspace、私有仓库或本机绝对路径。
- Herdr 执行、本地状态、恢复 journal、屏幕采集与交付命令留在 CLI。真实服务端/API/Postgres 集成测试不引入本仓库。

## 开发

- 包管理器、脚本和运行时统一使用 Bun，最低版本为 1.4.2。用 `bun install` 安装依赖，用 `bun run` 执行脚本。
- 环境变量只在 `src/env.ts` 通过 T3 Env 读取和校验；配置作为参数传入其他模块。
- 保留设备凭据、journal 恢复和不确定网络结果的语义，不把超时当作操作未发生。Codex 使用用户本地配置，不硬编码模型或自动批准交互。
- renderer vendor 的完整许可证、第三方 notices 与 provenance 必须随源码和打包产物保留；升级依照 vendor README，不直接编辑 vendor bundle。

## 验证与提交

- 测试使用 Bun 内置 runner，通过 `bun run test` 按文件启动独立进程。写测试应简洁，覆盖变化的核心行为即可。
- 常规验证用 `bun run check`，必要时用 `bun pm pack --dry-run --ignore-scripts` 核对分发文件。CI 在 Linux/macOS 执行，不要求私有凭据。
- 不让单测或 smoke 控制真实 Herdr pane、启动真实 Codex 任务或使用线上账号。
- 截图、录屏和原始日志仅保留本地，不提交到 Git；提交说明写必要的验证命令和结果。
- 完成改动并通过相关验证后，直接 `git commit` 和 `git push`，不必另行等待提醒。发布 npm 或改变已发布版本时遵循本次任务授权。
