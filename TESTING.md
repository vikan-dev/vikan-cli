# 测试

在独立 CLI 仓库根目录使用 Bun 1.4.2 或更高版本执行：

```sh
bun install --frozen-lockfile
bun run check
```

`check` 依次运行 TypeScript 检查、单测、构建和安装验证。CI 在 Linux 与 macOS 上执行相同命令，再检查 package 文件清单。所有日常检查都不需要 vikan 凭据、数据库、Herdr 服务或 Codex 登录。

## 单独运行

```sh
bun run typecheck
bun run test
bun run build
bun run smoke
```

测试 runner 为每个测试文件启动独立 Bun 进程，避免 `mock.module` 跨文件污染，并禁用自动加载本地 `.env`。通过参数筛选测试文件：

```sh
bun run test src/cli-entry.test.ts src/cli-link.test.ts
bun run test src/runner
bun run test src/herdr
bun run test src/cli-render-plan.test.ts
```

| 范围 | 验证内容 |
| --- | --- |
| 命令与配对 | 参数、退出码、版本、本地凭据、目录绑定与授权结果。 |
| runner | 任务队列、journal、回执重试和崩溃恢复。 |
| Herdr | 使用 fake exec 核对 pane 身份、进程归属和控制行为。 |
| 终端预览 | 可见画面采集、大小限制、去重与上传。 |
| 交付材料 | manifest 校验、幂等操作、状态和重试。 |
| 本地渲染 | Markdown 校验、HTML 输出、内嵌资源与 notices。 |

测试只操作临时目录和自有子进程，Herdr、Agent、S2 与网络 API 均使用本地 fake。进程身份测试会启动短暂的 Bun 子进程。真实 API/Postgres 集成测试继续在 vikan 服务端仓库维护，不复制到本仓库，也不因缺少数据库而跳过这里的单测。

## 独立运行与打包

`bun run check` 的 smoke 在仓库外验证构建结果，确认 bundle 不需要源码目录或 workspace 包；还会打包并在临时消费项目中安装，直接执行安装后的 `vikan` bin，检查版本和离线渲染。安装步骤需要访问公开依赖。手动检查时可以只复制构建文件：

```sh
bun run build
cli_smoke_dir=$(mktemp -d)
cp dist/index.js "$cli_smoke_dir/vikan.js"
bun "$cli_smoke_dir/vikan.js" --version
bun "$cli_smoke_dir/vikan.js" --help
bun "$cli_smoke_dir/vikan.js" deliverables render-plan --licenses
bun pm pack --dry-run --ignore-scripts
```

包中应有源码入口、运行所需的 vendor 资源、独立 bundle、README 和许可证，不应包含本地配置、测试 evidence、凭据或私有源码。`--dry-run` 只核对打包清单，不发布到 registry。

## 真实运行检查

适配器或配对流程的改动可在自己选择的测试项目中验证：安装并登录 Codex，进入 Linux/macOS 的 Herdr pane，执行 `vikan doctor`、`vikan connect`，在浏览器确认配对，然后从 vikan 发起任务。核对任务 pane、终端预览和实际回执；停止并重启 runner，检查恢复结果。

这类验证会使用所选 vikan 项目和本地 Codex 配置，属于单独的人工联调。日常 `check` 和 CI 不启动真实任务。验证截图、录屏和原始日志只保留本地，提交说明记录命令、结果与尚未验证的范围。
