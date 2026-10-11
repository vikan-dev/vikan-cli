# 维护与发布

公开仓库为 `vikan-dev/vikan-cli`，包名为 `@vikan/cli`，初始版本为 `0.1.0`。当前通过 Git 获取和安装，尚未发布到 npm；CI 只做检查，不自动发布包。

## 更新公开源码

1. 使用 Bun 1.4.2 或更高版本开发，运行 `bun install --frozen-lockfile`。
2. 若改动协议，先完成 SDK 更新，再把 `@vikan/sdk` Git 依赖固定到已推送的完整 commit SHA，执行 `bun install` 并提交 `bun.lock`。公开 CLI 的安装和检查不得要求访问私有服务端仓库。
3. 运行 `bun run check` 和 `bun pm pack --dry-run --ignore-scripts`。核对包内有源码入口、vendor 资源、bundle、README 和全部许可证；确认没有凭据、私有源码或本地 evidence。
4. 需要发新版本时，同步 `package.json` 与 CLI 的版本常量，并更新用户可见的变更说明。版本测试应验证二者一致。
5. 提交并推送改动，确认 Linux/macOS CI 通过。安装说明保持与实际可用渠道一致。

`bin` 使用源码入口，便于从 Git 安装；该路径依赖随包提供的源码、vendor 和公开 npm/Git 依赖。`bun run build` 另行生成可复制到仓库外的 `dist/index.js`。发布文件清单同时覆盖这两种使用方式。

## 首次 npm 发布

首次发布前，需要维护者拥有 npm `vikan` scope 下 `@vikan/cli` 的发布权限，并明确授权执行发布。GitHub organization 与 npm scope 分别管理。

确认拟发布版本、公开访问设置和 package 内容，并从干净 checkout 运行上述全部检查。维护者通过本机 npm 登录流程完成认证，不把 token 写入源码或提交。然后执行：

```sh
bun publish --access public
```

发布后核对 registry 中的版本和包内容，使用一个新目录验证安装及命令，再更新 README 的安装方式。此文档中的发布命令不是 CI 步骤，也不表示当前版本已经发布。
