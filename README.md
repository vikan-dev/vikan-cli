# vikan CLI

English | [简体中文](README.zh-CN.md)

Connect a local code repository to [vikan](https://app.vikan.dev), run Codex through Herdr, receive tasks, and submit plans, files, and validation results.

This is the standalone open-source repository for `@vikan/cli`. The HTTP protocol, runtime validation, and device client come from `@vikan/sdk/agent` in the [vikan SDK](https://github.com/vikan-dev/vikan-sdk). The CLI handles commands, local state, task recovery, Herdr integration, and terminal previews. Using the hosted vikan service does not require running your own API or database.

## Installation

Requires Bun 1.4.2 or later. Install from npm:

```sh
bun add --global @vikan/cli
vikan --version
vikan --help
```

You can also install from Git:

```sh
git clone https://github.com/vikan-dev/vikan-cli.git
cd vikan-cli
bun install --frozen-lockfile
bun run build
bun link
vikan --version
vikan --help
```

`bun link` registers the `vikan` command using `src/index.ts`, which runs directly from source with the installed dependencies. You can also run `bun run src/index.ts --help` from the repository. The build produces `dist/index.js`, a standalone file with a Bun shebang that you can copy elsewhere and run with `bun /path/to/index.js --help`. Run `bun unlink` from the installation directory to remove the link.

`connect` supports Linux and macOS. It requires Herdr and a configured, authenticated Codex installation, and must be launched inside a Herdr pane. Codex uses your local model, reasoning, sandbox, and approval settings. `--help`, `--version`, and local `render-plan` commands do not require Herdr or a vikan account.

## Connect a project

Open your code repository in Herdr:

```sh
cd /path/to/your/project
vikan doctor
vikan connect
```

On the first connection, the CLI displays a browser verification URL and a pairing code. Sign in to vikan in your browser, confirm the code, and select a workspace and project. The CLI then saves the binding and connects the runner. If the browser does not open automatically, copy the URL from your terminal. Running `vikan connect` again in a paired directory reconnects the runner and reconciles unfinished tasks.

The runner starts Codex in an adjacent Herdr pane that it creates, and sends task receipts and that pane's visible terminal content to vikan. Press Ctrl-C to stop the runner; exiting does not automatically close existing task panes. When delivery of a prompt or execution result cannot be confirmed, the CLI keeps a recovery journal and does not automatically resend the prompt. After updating the CLI, stop the runner and run `vikan connect` again in the same directory.

## Commands

| Command | Purpose |
| --- | --- |
| `vikan` / `vikan connect` | Pair the current directory if needed, then connect and recover the runner. |
| `vikan link` | Complete browser pairing only. Requires a Herdr pane. |
| `vikan status` | Show the directory binding, connection, and server-confirmed status. Works outside Herdr. |
| `vikan doctor` | Check Bun, Herdr, Codex, configuration, and network access. Outside Herdr, the pane check reports a failure. |
| `vikan unlink` | Revoke the directory binding and remove local credentials. Refuses while tasks remain unfinished; a network failure does not count as successful revocation. |
| `vikan deliverables <command>` | Render a plan or submit documents, files, and validation results from the current task. |
| `vikan --help` / `vikan --version` | Show help or the version without connecting or pairing. |

### Plans and deliverables

Generate an HTML plan that can be opened offline:

```sh
vikan deliverables render-plan --help
vikan deliverables render-plan --source ./plan.md --output ./plan.html
vikan deliverables render-plan --licenses
```

Rendering only requires Bun and a Markdown source file. The renderer and its licenses are bundled with the CLI. `render-plan --help` lists the supported Markdown and diagram syntax.

Deliverable commands such as `context`, `publish-stage`, `upload`, `finish-stage`, `status`, and `retry` use the current task's device credentials and runner journal. Network submissions must run in the task's Herdr pane and paired directory. Task prompts provide the exact CLI invocation. The `--run` argument checks task identity; it does not grant access on its own. See [DELIVERABLES.md](DELIVERABLES.md) for examples, receipt handling, and exit codes.

## Configuration and local data

| Environment variable | Purpose |
| --- | --- |
| `VIKAN_API_URL` | API origin for initial pairing. Defaults to `https://app.vikan.dev`; paired directories reconnect using their saved origin. |
| `VIKAN_CONFIG_DIR` | Local state directory. Defaults to `~/.config/vikan`. |
| `HERDR_ENV`, `HERDR_SOCKET_PATH` | Session information provided by Herdr. The CLI verifies the actual pane identity with the running Herdr instance. |

The CLI generates random device credentials and obtains authorization for the current account and project through browser pairing. This uses the SDK's agent device authentication flow, separate from the API key used by the SDK's main entry point. S2 command streams and terminal previews use short-lived stream tokens issued by the server; you do not need to configure an S2 master key.

Bindings, device credentials, recovery journals, and deliverable receipts are stored in the configuration directory, separated by API origin and account. Credential and deliverable input files are readable and writable only by their owner. The CLI does not write credentials into your project or modify its `AGENTS.md` or your global Codex settings. Terminal previews upload the running pane's visible content; deliverable commands upload the files you explicitly specify.

Directory execution locks and recovery ownership are stored separately under the system account's home directory at `~/.local/state/vikan/directories`. Their location does not change with `VIKAN_CONFIG_DIR`, the API origin, or the account. If the CLI reports unfinished recovery state for a checkout, use the original configuration directory and binding shown in the message to run `vikan connect`, and finish recovery before switching. Do not delete the lock files or `.owner.json` directly. Exiting the runner releases the kernel lock, while recovery records remain available to reconcile existing tasks.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs type checking, unit tests in separate processes, a build, and smoke checks for both the standalone bundle and the installed package outside the repository. Unit tests use fake API, Herdr, and S2 implementations; they do not require a database, a real account, or access to private repositories. The SDK dependency is pinned to a full commit SHA in its public Git repository, and protocol updates go through the SDK. See [TESTING.md](TESTING.md) for details and [PUBLISHING.md](PUBLISHING.md) for maintenance and release instructions.

The CLI is available under the [MIT License](LICENSE). Full licenses and dependency notices for the bundled renderer are in [vendor/answer-me-with-html](vendor/answer-me-with-html/README.md). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for other attributions.
