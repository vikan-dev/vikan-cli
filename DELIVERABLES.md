# Issue stage submissions from the device CLI

Plan, Design, Validation and custom stages share `publish-stage` and
`finish-stage`. A stage appears below the issue title only after submission.
Each stage keeps its own revision history, body, files, checks and run provenance.

Network submissions run from the paired checkout in the issue run's Herdr pane. The runner prompt
contains the exact CLI invocation if `vikan` is not globally installed. Keep
the runner connected. `--run` checks identity; pairing and the runner journal
provide credentials and current session/claim authority privately.

```sh
vikan deliverables --help
vikan deliverables context --run "$RUN_ID" > context.json
```

The summary contains `stages:[{stage,latest,currentRun}]`. Use the selected
stage's `latest.stageId` as `expectedLatestStageId`, or explicit `null` when
that stage does not exist. `currentRun:null` means the current run has no
submission, even when older revisions exist.

## Render and publish a visual Plan

Use a visual Plan when module relationships, architecture, real alternatives or
dependent steps benefit from a diagram. Small fixes can use a short text Plan.
Publish the Plan before implementation. Keep one `plan.md` source in the task's
language, normally 4–6 panels and at most 8. Each `##` heading starts a panel.

This local command works outside a paired checkout or Herdr, with no `--run`,
network, database, browser service, global skill or separate renderer install:

```sh
vikan deliverables render-plan --help
vikan deliverables render-plan --licenses
vikan deliverables render-plan --source ./plan.md --output ./plan.html > ./plan-render.json
```

The runner supplies an absolute Bun/source-or-bundle command prefix; use that
prefix in place of `vikan deliverables` when there is no global installation.
The pinned renderer and third-party notices are embedded in `dist/index.js`;
the HTML also retains applicable notices and its original source. Rendering uses
private temporary state and does not use the reader's `AM_HOME` or start a browser.

Adapt this small example to the actual task. Keep an `ask` only if the decision is
still open and would change the work:

````markdown
---
title: vikan plan
lang: en
---
## Scope
Add a local renderer and publish its HTML with the same Plan source.

## Delivery
```flow LR
Draft -> Render -> Upload -> Publish
```

## Verification
| Check | Purpose |
| --- | --- |
| Standalone CLI | Render outside the checkout |
| Download | Check the saved HTML bytes |

## Decision
```ask
Which view should the next iteration support?
* Download | Keep the initial scope small
- Embedded preview | Requires a separate isolation design
```
````

Supported content includes paragraphs, lists, tables, ordinary code fences and
`flow`, `sequence`, `tree`, `er`, `timeline`, `callout`, `kv`, `ask` blocks. Fences
must start at the beginning of a line. `render-plan --help` gives component syntax.
Raw `html`/`svg` blocks, active HTML tags, Markdown/HTML images, code `src=`
references and external active resources are rejected with line diagnostics.
Put literal HTML examples inside a `text` code fence. Cite repository evidence
with the real commit, path and line; the renderer never reads referenced code.

The source must be a bounded UTF-8 regular file and must satisfy the shared text
document contract (including its 100,000-character and complexity limits).
Rendering reads one snapshot, uses a 30-second timeout and caps the generated
file at 5 MiB. Existing output remains intact if validation or rendering fails.
Input and output must be different files. The default shadcn theme follows the
system light/dark preference; generated HTML works offline without a CDN.

Success prints JSON with `outputPath`, `byteSize`, `sourceSha256`, `rendererCommit`
and `document: {format:"text",text:<exact source>}`. Only the `document` value goes
into the existing stage manifest. Exit 0 means the local HTML is ready; upload
and publication still need their own confirmed server receipts.

Upload first with a saved UUID, different from the publication operation UUID:

```sh
vikan deliverables upload --run "$RUN_ID" --file ./plan.html --operation-id "$UPLOAD_OPERATION_ID" > ./plan-upload.json
```

Read the current context and create the manifest once. The following Bun script
copies the source document and confirmed upload ID without retyping either:

```sh
vikan deliverables context --run "$RUN_ID" > ./context.json
bun --no-env-file - <<'BUN'
const context = await Bun.file('./context.json').json()
const rendered = await Bun.file('./plan-render.json').json()
const uploaded = await Bun.file('./plan-upload.json').json()
const plan = context.summary.stages.find(entry => entry.stage === 'plan')
await Bun.write('./plan.json', JSON.stringify({
  operationId: crypto.randomUUID(),
  stage: 'plan',
  expectedLatestStageId: plan?.latest?.stageId ?? null,
  title: 'vikan implementation plan',
  summary: 'Review the Plan source or download its visual version.',
  document: rendered.document,
  files: [{ fileId: uploaded.file.fileId, posterFileId: null,
    caption: 'Visual plan (HTML)', checkIds: [] }],
}, null, 2))
BUN
vikan deliverables publish-stage --run "$RUN_ID" --manifest ./plan.json
```

Retain `plan.json` for retries; do not regenerate its UUID after an uncertain
result. The server receipt assigns the actual Plan revision. Stage text shows
the source Markdown and diagram syntax literally; readers download the HTML
attachment and open it locally. The visual Plan is planning material, so do not
record it as a passed check or verification evidence.

When the source changes, render it again. Changed HTML bytes need a new upload
operation UUID; changed document/files need a new publication UUID and revision.
Completed revisions and their attachments are immutable. `expectedLatestStageId`
checks the current Plan revision; `basedOnStageId` links a dependency and cannot
replace that check. A confirmed upload can be reused after a publication failure
within the same run. A different run must upload again.

For a render error, use its line diagnostics and retry at most twice after
correction. If it still fails, publish a text Plan and explain the rendering
failure and missing visual attachment in its summary. An uncertain upload or
publication instead uses `retry` with the original UUID and saved input/bytes;
it must not create a duplicate fallback revision.

The offline HTML's ask selections, panel comments and remarks can be copied into
the existing Agent supplement input, with the reviewed Plan version, then
explicitly submitted. A recommended option's initial selection remains
unanswered until the reader confirms or changes it. Browser-local feedback is
not synchronized to vikan and need not survive another device or file path.
Reading, copying feedback or publishing a completed Plan does not approve,
pause/resume or confirm a run, or change issue state. Use the existing conversation
rules for decisions that need the user's input.

## Publish a document or design file

Save this manifest as `design.json`, replacing the UUID placeholders once.
Use `stage:"plan"` for a plan; any lowercase slug up to 64 characters is allowed.

```json
{
  "operationId":"SAVED_OPERATION_UUID",
  "stage":"design",
  "expectedLatestStageId":null,
  "title":"Issue interaction design",
  "summary":"Describe the interactions",
  "document":{"format":"text","text":"Complete design document"}
}
```

```sh
vikan deliverables publish-stage --run "$RUN_ID" --manifest ./design.json
```

`document.format=text` preserves literal text, including Markdown. Use
`{format:"json",content:<valid Tiptap document>}` for structured content.
Publication defaults to `status:"completed"`, `checks:[]`, `files:[]` and
`basedOnStageId:null`. Completed versions are immutable; another publication
with a new operation UUID and the current expected ID creates the next revision.
Revision counters are independent per issue and stage.

To include a design file, upload its explicit path first:

```sh
vikan deliverables upload --run "$RUN_ID" --file ./design.html --operation-id "$UPLOAD_OPERATION_ID"
```

Use the receipt's `file.fileId` in the publication's optional `files` array:

```json
{"files":[{"fileId":"UPLOADED_FILE_UUID","posterFileId":null,"caption":"Design file","checkIds":[]}]}
```

Files are displayed in the stage detail. Verified images/videos preview inline;
HTML and other unsupported formats remain downloadable. Uploaded files retain
the issue owner and do not require attachment to the issue description. The CLI
checks ready upload receipts for this run, then the server claims the full set
atomically. For a video, optional `posterFileId` must name a verified image.

## Start and finish validation

Use the same `publish-stage` command with `stage:"validation"`, `status:"running"`
and an optional `basedOnStageId` referencing the exact Plan or Design version.
Start with the validation stage's latest ID (or null), not the plan's ID.

```json
{
  "operationId":"SAVED_START_UUID",
  "stage":"validation",
  "status":"running",
  "expectedLatestStageId":null,
  "basedOnStageId":"PLAN_OR_DESIGN_STAGE_ID",
  "title":"Implementation checks",
  "summary":"Checks started",
  "document":{"format":"text","text":"What will be checked"},
  "checks":[{"id":"build","title":"Build","status":"running","command":"bun run build","detail":null}],
  "files":[]
}
```

```sh
vikan deliverables publish-stage --run "$RUN_ID" --manifest ./validation-start.json
```

Retain `result.stageId` and `result.version`. Execute the real checks and upload
actual files. Finish with a new operation UUID and the complete replacement
body/checks/files set. A finish manifest looks like this; replace the template's
skipped check with the observed result:

```json
{
  "operationId":"SAVED_FINISH_UUID",
  "expectedVersion":1,
  "status":"completed",
  "summary":"Actual results and limitations",
  "document":{"format":"text","text":"Actual observations"},
  "checks":[{"id":"build","title":"Build","status":"skipped","command":"bun run build","detail":"Template; replace after execution"}],
  "files":[],
  "failureReason":null
}
```

```sh
vikan deliverables finish-stage --run "$RUN_ID" --stage "$STAGE_ID" --manifest ./validation-finish.json
```

`completed` means execution ended and can include failed checks. `failed`
requires a nonempty `failureReason`. Empty checks never mean passed. Reruns
publish a new revision; a finished version cannot reopen. These rules work for
any stage key. Reading a stage never approves the run or changes issue state.

## Recovery and exit codes

All successful network writes print the actual server receipt as JSON. An outcome is
confirmed only after the response passes shared schema and identity checks.
The CLI reauthorizes even a known receipt on retry. Credentials, sessionId and
claimEpoch are never manifest fields or argv options; the latest journal
claim is loaded on each invocation, including after runner reconciliation.

```sh
vikan deliverables status --run "$RUN_ID"
# Use the exact operation UUID printed by the failed command/status.
vikan deliverables retry --run "$RUN_ID" --operation-id 'the-saved-operation-UUID'
```

| Exit | Meaning and next step |
| --- | --- |
| 0 | Local rendering completed, a server receipt was confirmed, or requested help/context/local status was read. |
| 1 | Local file, storage or renderer execution failure. Existing render output is preserved; inspect diagnostics. |
| 2 | Invalid command/manifest/source. Use `--help` and any line diagnostics; no malformed submission is sent. |
| 3 | Missing, invalid or revoked device credential. Restore pairing for the original binding; keep submissions. Device credentials have no separate expiry timestamp in the current API. |
| 4 | Wrong directory/pane/run, expired/superseded session/claim, or lost access. Resume/reconcile the owning runner or restore access. |
| 5 | Network, timeout, damaged/untrusted response, or a retryable operation. Outcome is unconfirmed; retry unchanged. |
| 6 | Reused UUID with changed input, stale stage version, or rejected evidence. Inspect context and receipts; genuine changed input requires a new UUID. |

`status` distinguishes `prepared`, `unconfirmed`, `refused` and `committed`.
A later authorization refusal cannot turn an earlier unconfirmed commit into
“never submitted”. A previous receipt is retained if a later retry is denied.
The operation ledger is under the user config directory at
`origins/<origin>/users/<user>/deliverables/<binding>/`; input/receipt JSON and
upload snapshots are mode 0600. Do not delete these files while resolving a
submission. `unlink` removes pairing/journal state, but leaves this ledger for
inspection; it does not migrate pending operations to a different binding.

Local rendering does not create an entry in the submission ledger. The runner
adds the visual Plan guidance only to the initial issue prompt; existing
prompt acknowledgement, uncertain-delivery, cancel and recovery rules still
apply. Issue-less exploration and project-document runs keep their own guidance;
supplements are unchanged. Rebuild the CLI, stop the runner and reconnect to apply
new guidance to new starts; acknowledged prompts are not resent. On Linux and
macOS, `connect` uses the real Herdr adapter to create an owned sibling pane and
start Codex with the user's local settings.
The issue prompt contains this CLI's actual source/bundle entry; no global
installation or credential arguments are needed. Agent process identity uses
Linux `/proc` or macOS native process identity. Other platforms are rejected
before pairing or execution. The local renderer does not use the Herdr adapter.

Automated local CLI checks are documented in [TESTING.md](TESTING.md). They use
fake API, Herdr and S2 implementations and run without a database or account.
The private service's real HTTP/Postgres/browser integration tests remain in
the service repository; they are not required to build or test this CLI.
For a live check, use your own paired test project and local Codex configuration.
Keep screenshots, recordings and raw logs local; do not commit them to Git.
