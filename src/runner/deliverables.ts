import type { RunContext } from '../api/client.ts'

/** Shell is only used by the recipient Agent. Quote every injected local path;
 * neither credentials nor session/claim authority appear in this command. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
export function deliverablesCommand(invocation: readonly string[], configDir: string, apiOrigin: string): string {
  if (invocation.length === 0) throw new Error('Missing CLI invocation')
  return `env ${shellQuote(`VIKAN_CONFIG_DIR=${configDir}`)} ${shellQuote(`VIKAN_API_URL=${apiOrigin}`)} ${invocation.map(shellQuote).join(' ')} deliverables`
}

export function issueDeliveryInstructions(context: RunContext, command: string): string {
  if (!context.issue) return ''
  return [
    '# vikan issue deliverables',
    `Issue ${context.issue.identifier} (${context.issue.id}); run ${context.runId}; project ${context.project.id}; workspace ${context.project.workspaceId}.`,
    "Execute the following in this run's Herdr pane, from the paired checkout (repository subdirectories are supported). Keep the runner connected.",
    `${command} --help`,
    `${command} context --run ${context.runId}`,
    'Publish stage=plan before making changes. Publish stage=design with design documents/files when present; other stage keys use the same API. Publish a new revision when an artifact changes.',
    'Use context.summary.stages entry for the chosen stage: latest.stageId is expectedLatestStageId (explicit null only when that stage does not exist). Keep a stable operationId UUID and each JSON manifest.',
    'document.format=text preserves plain text and literal Markdown; document.format=json accepts the shared Tiptap document JSON. --help lists all required fields.',
    'For cross-module or architecture changes, real alternatives, or dependent execution steps, add a visual Plan HTML attachment. Small fixes can use a short text Plan. Choose by complexity, not word count.',
    'Maintain one plan.md in the task language; recommend 4–6 panels, at most 8. Explain scope, structure, tradeoffs, implementation and checks. Use ask only for a real unresolved decision. A small syntax example follows; replace its content with the actual plan:',
    '---\ntitle: vikan plan\n---\n## Flow\n```flow LR\nDraft -> Render -> Upload -> Publish\n```\n## Checks\n| Check | Purpose |\n| --- | --- |\n| Typecheck | Check types |',
    'Supported diagram blocks: flow, sequence, tree, er, timeline, callout, kv, ask. Use ordinary code fences for literal code. No raw html/svg blocks, active HTML tags, images, external resources or code src= references. Cite real commit/path/line evidence in text. Read the local syntax help when needed:',
    `${command} render-plan --help`,
    `${command} render-plan --source ./plan.md --output ./plan.html > ./plan-render.json`,
    'render-plan is local: no --run, pairing, Herdr or network is required. Success creates an HTML file and JSON {outputPath,byteSize,sourceSha256,rendererCommit,document}; it does not publish anything.',
    `${command} upload --run ${context.runId} --file ./plan.html --operation-id <saved-plan-upload-UUID>`,
    'After the upload receipt, create plan.json with its own saved operationId, stage=plan, the current expectedLatestStageId, title, summary, document copied unchanged from plan-render.json, and files=[{fileId:<receipt.file.fileId>,posterFileId:null,caption:"Visual plan (HTML)",checkIds:[]}]. Do not copy the renderer metadata into the strict manifest. The visual plan is planning material, not validation evidence.',
    `${command} publish-stage --run ${context.runId} --manifest ./plan.json`,
    'Read the server receipt for the assigned revision. HTML is downloaded and opened in a browser; the stage body keeps the same source as literal Markdown. Source changes require rerendering; changed HTML bytes need a new upload UUID and changed document/files need a new publication UUID and revision. expectedLatestStageId is the current-stage CAS check; basedOnStageId is a dependency reference, not a replacement for it. Reuse confirmed uploads only within this run; another run must upload again.',
    'For renderer errors, correct the indicated lines and retry at most twice. If rendering still fails, publish the text Plan and explain the missing visual attachment and failure in its summary. For uncertain upload/publication outcomes, use the original operation UUID and saved input/bytes with retry; do not treat uncertainty as a render failure or publish a duplicate fallback.',
    'HTML ask choices and comments are local feedback. A preselected recommendation is unanswered until the user confirms or changes it. The user copies feedback, includes the reviewed Plan version, and explicitly submits it through existing Agent supplement instructions. Reading, copying or completing a Plan neither approves nor pauses/resumes the run; follow the current conversation rules for real decisions. Do not promise automatic feedback sync or an approval gate.',
    'Start stage=validation with status=running and basedOnStageId referencing the explicit plan/design stageId (or null). Run real checks and record actual outcomes.',
    `${command} publish-stage --run ${context.runId} --manifest ./validation-start.json`,
    `${command} upload --run ${context.runId} --file ./evidence.png --operation-id <saved-upload-UUID>`,
    'Upload actual screenshots/video/attachments by explicit path, using a distinct saved UUID for each file. Reference ready fileIds from returned server receipts, with optional ready PNG posterFileId for video.',
    `${command} finish-stage --run ${context.runId} --stage <stageId-from-publish-receipt> --manifest ./validation-finish.json`,
    'Finish supplies expectedVersion from the start receipt and the entire document/checks/files set. Report skipped or failed checks honestly; explain missing evidence. Never use design/demo media as proof.',
    'completed means validation execution ended, not all checks passed or human approval. No command changes issue status or confirms the run.',
    `${command} status --run ${context.runId}`,
    `${command} retry --run ${context.runId} --operation-id <saved-operation-UUID>`,
    'A lost response is unconfirmed: retry the same saved operation/bytes, never invent a new UUID to bypass it. The CLI loads pairing and current runner authority privately; do not read, print or copy credential files into commands, prompts, logs or evidence.',
    'Only API receipts confirm delivery; terminal text or agent completion does not.',
  ].join('\n')
}

/** Issue-less explore runs report through findings instead of stages. */
export function runFindingsInstructions(context: RunContext, command: string): string {
  if (context.issue) return ''
  return [
    '# vikan run findings',
    `Run ${context.runId}; project ${context.project.id}; workspace ${context.project.workspaceId}.`,
    'This is an exploration run: read the repository, identify feature gaps, bugs and improvement opportunities worth becoming issues. Do not modify code; do not commit or push.',
    'Follow the scope of the exploration prompt above. If it specifies a topic, investigate and report findings relevant to that topic; explore freely only when no topic was specified.',
    'Publish every worthwhile discovery as a finding — one title plus a body with concrete evidence (file paths, current behavior, why it matters, a sketch of the fix). Publish batches as you go instead of saving them for the end.',
    "Write a JSON manifest and publish it in this run's Herdr pane, from the paired checkout:",
    `${command} publish-findings --run ${context.runId} --manifest ./findings.json`,
    'Manifest shape: {"operationId":"<stable-UUID>","findings":[{"title":"...","body":"..."}]} — 1 to 50 entries per batch, plain text (Markdown allowed) in both fields. Use a distinct saved operationId UUID per batch.',
    'A lost response is unconfirmed: retry the same saved operationId and identical manifest, never invent a new UUID to bypass it. Only API receipts confirm delivery; terminal text does not. Findings are delivered to the project owner for review — never include secrets, credentials or tokens.',
  ].join('\n')
}

/** A project-document run returns an immutable Markdown/HTML source snapshot. */
export function projectDocumentDeliveryInstructions(context: RunContext, command: string): string {
  if (!context.projectDocument) return ''
  const document = context.projectDocument
  const annotations = document.annotations.length
    ? document.annotations.map(annotation => `- canonical plaintext offsets ${annotation.start}..${annotation.end}; selected “${annotation.selectedText}”; prefix “${annotation.prefix}”; suffix “${annotation.suffix}”; note: ${annotation.body}`).join('\n')
    : '(none)'
  return [
    '# vikan project document',
    `Document “${document.title}” (${document.id}), current version ${document.version}; run ${context.runId}; project ${context.project.id}; workspace ${context.project.workspaceId}.`,
    'Revise the document according to the prompt and the version-bound annotations below. Preserve useful content unless the prompt asks to remove it. Annotation offsets and context use the rendered canonical plaintext, not raw Markdown/HTML source.',
    `Current format: ${document.format}. Current source follows:\n${document.source}`,
    `Annotations on this version:\n${annotations}`,
    'When the revision is ready, write a JSON manifest with exactly {"operationId":"<stable-UUID>","expectedVersion":<current-version>,"format":"markdown"|"html","source":"<complete revised source>"}.',
    `${command} project-document --run ${context.runId} --manifest ./project-document.json`,
    'The source is parsed and sanitized by the API before it becomes a new immutable version. A stale expectedVersion or invalid source is rejected; retry the same operationId only when the outcome is unconfirmed.',
  ].join('\n')
}
