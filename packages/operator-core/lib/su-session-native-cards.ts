/** Translate native questions into the existing PUI card/response protocol.
 * The shared correlator validates the workspace and response exactly once. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { cancelPendingCardsForRun, registerCard, resolveCardResponse } from '@papercusp/agent-mcp';
import type { CanUseTool, OnElicitation, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { nativeFormFields } from './su-session-native-form';
import { nativeCardCorrelationId } from './su-session-native-card-identity';
import { approvalCardText, displayPath, humanToolName } from './su-session-approval-display';
import type { SuSessionEventInput } from './su-session-host';
import type { RpcFrame } from './su-session-stdio-peer';

const record = (value: unknown): RpcFrame => value && typeof value === 'object' && !Array.isArray(value) ? value as RpcFrame : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const nativeQuestions = z.array(z.object({
  id: z.string().min(1), question: z.string().min(1), header: z.string().optional(),
  isOther: z.boolean().optional(), isSecret: z.boolean().optional(), multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() }))
    .min(1).nullable().optional(),
})).min(1).refine(questions => new Set(questions.map(question => question.id)).size === questions.length,
  'Native questions must have distinct IDs').refine(questions => questions.every(question =>
  !question.options || new Set(question.options.map(option => option.label)).size === question.options.length),
  'Native options must have distinct labels');
const permissionPath = z.discriminatedUnion('type', [
  z.object({ type: z.literal('path'), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal('glob_pattern'), pattern: z.string().min(1) }).strict(),
  z.object({ type: z.literal('special'), value: z.discriminatedUnion('kind', [
    z.object({ kind: z.enum(['root', 'minimal', 'tmpdir', 'slash_tmp']) }).strict(),
    z.object({ kind: z.literal('project_roots'), subpath: z.string().nullable() }).strict(),
    z.object({ kind: z.literal('unknown'), path: z.string(), subpath: z.string().nullable() }).strict(),
  ]) }).strict(),
]);
const requestedPermissions = z.object({
  network: z.object({ enabled: z.boolean().nullable() }).strict().nullable().optional(),
  fileSystem: z.object({ read: z.array(z.string()).nullable().optional(), write: z.array(z.string()).nullable().optional(),
    globScanMaxDepth: z.number().int().nonnegative().optional(),
    entries: z.array(z.object({ path: permissionPath, access: z.enum(['read', 'write', 'deny']) }).strict()).optional(),
  }).strict().nullable().optional(),
}).strict();

/** Claude's allow suggestions, re-scoped to this runtime: a PUI card never
 * writes a settings file (D-021). */
export function sessionAllowRules(suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  const rules = (suggestions ?? []).flatMap((update) => update.type === 'addRules' && update.behavior === 'allow'
    && update.rules.length ? [{ ...update, destination: 'session' as const }] : []);
  if (rules.length) return rules;
  // An edit offers no rule, only Claude Code's "switch to accept edits for this
  // session" (stock 2.1.289 frame, D-028): the same session-scoped switch.
  return (suggestions ?? []).flatMap((update) => update.type === 'setMode' && update.mode === 'acceptEdits'
    ? [{ ...update, destination: 'session' as const }] : []);
}

/** Option 2 of an approval: what the remembered choice grants, with the tool
 * named the way the card names it (P-008: never a raw MCP id). It lasts for
 * this session's runtime (D-021: never a settings file). */
export function rememberedApprovalLabel(updates: readonly PermissionUpdate[]): string | undefined {
  const rules = updates.flatMap((update) => update.type === 'addRules'
    ? update.rules.map((rule) => rule.ruleContent ? `${humanToolName(rule.toolName)}(${rule.ruleContent})` : humanToolName(rule.toolName)) : []);
  if (rules.length) return `Yes, and don't ask again for ${rules.join(', ')} this session`;
  return updates.some((update) => update.type === 'setMode' && update.mode === 'acceptEdits')
    ? 'Yes, and allow all edits this session' : undefined;
}

/** D-028: the three answers of a tool-approval card, by option id. */
export type ApprovalAnswer = 'yes' | 'always' | 'no';
/** One tool-approval card: the call's row title, Claude Code's question, the
 * change between them, and option 2's label when the engine can remember. */
export interface ApprovalRequest { title: string; question: string; body: string[]; details?: string; always?: string; accept?: boolean }
/** What Claude is told when the owner picks No: like Claude Code, the turn
 * stops and the owner says what to do instead in the next message. */
export const REJECTED_TOOL_MESSAGE = 'The user said no to this tool call. Nothing was run or changed. '
  + 'Stop here and wait for the user to say what to do instead.';
/** OMP tools whose remembered "yes" covers only the exact same request. */
const OMP_COMMAND_TOOL = /^(bash|shell|exec|python|eval|ssh|run)/i;

export interface SuNativeCardsOptions {
  /** The chat's launch directory; approval cards show paths relative to it. */
  cwd?: string;
  /** Stops the running turn after an OMP approval answered No (Claude and
   * Codex stop their own turn from the reply). */
  stopTurn?: () => void;
  /** Called when option 2 switched Claude to accept-edits for the session. */
  approvalsChanged?: (mode: 'auto-edit') => void;
  /** An unanswered native request expires without granting permission. */
  requestTimeoutMs?: number;
}

/** What the model is told when the owner skips (Esc / Decline) a question
 * card. P-014: a skip is a normal choice, not a failure, so the wording must
 * not read as an error the agent should apologise for or work around, and it
 * must stop the agent re-asking the same question. An interrupt is different
 * (the whole turn is ending) and keeps the generic denial. */
export const SKIPPED_QUESTION_MESSAGE = 'The user skipped this question without answering. '
  + 'This is not an error: continue without that answer, and do not ask the same question again.';

export class SuNativeCards {
  private epoch = 0;
  private readonly cwd?: string;
  /** OMP approvals answered "Yes, and don't ask again" in this runtime (D-028). */
  private readonly ompAllowed = new Set<string>();
  private readonly codexRequests = new Map<string, string>();
  private readonly conflictingCodexRequests = new Set<string>();
  private readonly elicitations = new Map<string, { fingerprint: string; abort: AbortController;
    result: ReturnType<OnElicitation> }>();
  private readonly claudeTools = new Map<string, { fingerprint: string; abort: AbortController; result: ReturnType<CanUseTool> }>();
  constructor(private readonly workspaceId: string, private readonly runId: string,
    private readonly emit: (event: SuSessionEventInput) => void, private readonly options: SuNativeCardsOptions = {}) {
    this.cwd = options.cwd;
  }

  cancel(): void {
    this.epoch++;
    for (const request of this.elicitations.values()) {
      request.abort.abort();
      // Retain a cancellation tombstone, never a settled private answer that
      // an old callback could replay into a later turn.
      request.result = Promise.resolve({ action: 'cancel' });
    }
    for (const request of this.claudeTools.values()) {
      request.abort.abort();
      request.result = Promise.resolve({ behavior: 'deny', message: 'Native request was cancelled' });
    }
    cancelPendingCardsForRun(this.runId);
  }

  private async ask(turnId: string, prompt: string, choices?: string[]): Promise<string | null> {
    const answers = await this.askAnswers(turnId, prompt, choices?.map((label) => ({ label })));
    return answers?.[0] ?? null;
  }

  /** D-028: one tool-approval card. `no` is also what Esc (a decline) means;
   * null means the card was cancelled because the turn is already ending. */
  private async askApproval(turnId: string, request: ApprovalRequest, agent: string,
    signal?: AbortSignal): Promise<ApprovalAnswer | null> {
    const choices = [...(request.accept === false ? [] : [{ id: 'yes', label: 'Yes' }]), ...(request.always ? [{ id: 'always', label: request.always }] : []),
      { id: 'no', label: `No, and tell ${agent} what to do instead` }];
    const answer = await this.openCard(turnId, [request.question, ...request.body].join('\n'), choices, false, signal,
      request.details, { title: request.title, question: request.question, body: request.body });
    if (answer.action === 'decline') return 'no';
    return answer.action === 'submit' ? answer.values[0] as ApprovalAnswer : null;
  }

  private async askAnswers(turnId: string, prompt: string,
    choices?: Array<{ label: string; description?: string }>, multiSelect = false, signal?: AbortSignal,
    details?: string): Promise<string[] | null> {
    const answer = await this.openCard(turnId, prompt, choices?.map((choice, index) => ({ id: String(index), ...choice })),
      multiSelect, signal, details);
    if (answer.action !== 'submit') return null;
    return choices?.length ? answer.values.map((pick) => choices[Number(pick)].label) : answer.values;
  }

  /** Opens one card and waits. A choice card answers with the picked option
   * ids, a text card with its one value. */
  private async openCard(turnId: string, prompt: string,
    choices: Array<{ id: string; label: string; description?: string }> | undefined, multiSelect: boolean,
    signal?: AbortSignal, details?: string, approval?: { title: string; question: string; body: string[] },
    input?: { sensitive?: boolean; privateLink?: string; allowEmpty?: boolean; validate?: (values: string[]) => boolean },
  ): Promise<{ action: 'submit'; values: string[] } | { action: 'decline' | 'cancel' }> {
    if (signal?.aborted) return { action: 'cancel' };
    const presentation = choices?.length
      ? { kind: multiSelect ? 'checkbox' as const : 'radio' as const,
        options: choices.map(choice => ({ ...choice, ...(choice.description ? { hint: choice.description } : {}) })),
        ...(input?.allowEmpty ? { allowEmpty: true } : {}) }
      : { kind: 'text' as const, ...(input?.sensitive ? { sensitive: true } : {}), ...(input?.allowEmpty ? { allowEmpty: true } : {}) };
    const baseSchema: z.ZodType<{ picks: string[] } | { value: string }> = choices?.length
      ? z.object({ picks: z.array(z.string()).min(input?.allowEmpty && multiSelect ? 0 : 1).max(multiSelect ? choices.length : 1).refine((picks) => presentation.kind !== 'text'
        && new Set(picks).size === picks.length && picks.every((pick) => presentation.options.some((option) => option.id === pick)), 'Choose displayed options') })
      : z.object({ value: z.string() });
    const dataSchema = baseSchema.refine(payload => !input?.validate || input.validate('picks' in payload
        ? payload.picks.map(pick => choices!.find(choice => choice.id === pick)!.label) : [payload.value]), 'Invalid response');
    const card = registerCard({ workspaceId: this.workspaceId, runId: this.runId,
      correlationId: nativeCardCorrelationId(this.runId),
      spec: { prompt, dataSchema, presentation, privateLink: input?.privateLink,
        allowDecline: true, timeoutMs: this.options.requestTimeoutMs ?? 300_000 } });
    const cancel = () => { resolveCardResponse({ correlationId: card.correlationId, action: 'cancel', expectedWorkspaceId: this.workspaceId }); };
    signal?.addEventListener('abort', cancel, { once: true });
    this.emit({ type: 'card', phase: 'opened', turnId, card: {
      correlationId: card.correlationId, createdAt: Date.now(), prompt, fallbackText: prompt,
      ...(details ? { details } : {}), ...(approval ? { approval } : {}),
      presentation: { ...presentation, ...(input?.privateLink
        ? { link: `/api/ui/cards/${encodeURIComponent(card.correlationId)}/link` } : {}) }, allowDecline: true,
    } });
    const response = await card.result.finally(() => signal?.removeEventListener('abort', cancel));
    this.emit({ type: 'card', phase: 'closed', turnId, correlationId: card.correlationId,
      resolution: response.action === 'submit' ? 'submitted' : response.action === 'decline' ? 'declined' : 'cancelled' });
    if (response.action !== 'submit') return { action: response.action === 'decline' ? 'decline' : 'cancel' };
    return { action: 'submit', values: 'picks' in response.payload ? response.payload.picks : [response.payload.value] };
  }

  handleClaudeElicitation(request: Parameters<OnElicitation>[0], turnId: string,
    options: Parameters<OnElicitation>[1]): ReturnType<OnElicitation> {
    const key = options.requestId, fingerprint = createHash('sha256').update(JSON.stringify([turnId, request])).digest('hex');
    const seen = this.elicitations.get(key);
    if (seen) {
      if (seen.fingerprint === fingerprint) return seen.result;
      seen.abort.abort();
      seen.result = Promise.resolve({ action: 'cancel' });
      return seen.result;
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (options.signal.aborted) cancel();
    options.signal.addEventListener('abort', cancel, { once: true });
    const result = this.elicit(request, turnId, abort.signal).finally(() => options.signal.removeEventListener('abort', cancel));
    this.elicitations.set(key, { fingerprint, abort, result });
    return result;
  }

  private async elicit(request: Parameters<OnElicitation>[0], turnId: string,
    signal?: AbortSignal): ReturnType<OnElicitation> {
    const epoch = this.epoch;
    const cancelled = () => epoch !== this.epoch || signal?.aborted;
    try {
      if (cancelled()) return { action: 'cancel' };
      if (request.mode === 'url') {
        const target = new URL(request.url ?? '');
        if (target.protocol !== 'https:' || target.username || target.password || !request.elicitationId) {
          throw new Error('Unsupported authentication link');
        }
        // Auth messages may echo their private target. Display only a fixed
        // instruction and safe origin; no path, query, fragment or server text.
        const answer = await this.openCard(turnId, `Complete authentication at ${target.origin}, then continue.`,
          [{ id: 'continue', label: 'Continue after authentication' }], false, signal, undefined, undefined,
          { privateLink: target.href });
        return cancelled() || answer.action === 'cancel' ? { action: 'cancel' }
          : { action: answer.action === 'submit' ? 'accept' : 'decline' };
      }
      if (request.mode !== undefined && !['form', 'openai/form', 'openaiForm'].includes(request.mode)) throw new Error('Unsupported elicitation mode');
      const fields = nativeFormFields(request.requestedSchema);
      const content: Record<string, string | number | boolean | string[]> = {};
      if (!fields.length) {
        const answer = await this.openCard(turnId, 'Submit the empty MCP form?', [{ id: 'submit', label: 'Submit' }], false, signal);
        return cancelled() || answer.action === 'cancel' ? { action: 'cancel' }
          : answer.action === 'decline' ? { action: 'decline' } : { action: 'accept', content: {} };
      }
      for (const field of fields) {
        if (cancelled()) return { action: 'cancel' };
        if (field.optional) {
          const include = await this.openCard(turnId, `Include optional field ${field.key}?`,
            [{ id: 'yes', label: 'Include' }, { id: 'no', label: 'Omit' }], false, signal);
          if (include.action !== 'submit' || cancelled()) return { action: include.action === 'decline' ? 'decline' : 'cancel' };
          if (include.values[0] === 'no') continue;
        }
        const choices = field.choices?.map((choice, index) => ({ id: String(index), ...choice }));
        const answer = await this.openCard(turnId, [request.title, request.message, field.prompt].filter(Boolean).join('\n'), choices, field.multi, signal, undefined, undefined,
          { sensitive: field.sensitive, allowEmpty: field.allowEmpty,
            validate: values => { try { field.parse(values); return true; } catch { return false; } } });
        if (cancelled() || answer.action !== 'submit') return { action: answer.action === 'decline' ? 'decline' : 'cancel' };
        Object.defineProperty(content, field.key, { enumerable: true, value: field.parse(choices
          ? answer.values.map(pick => choices[Number(pick)].label) : answer.values) });
      }
      return cancelled() ? { action: 'cancel' } : { action: 'accept', content };
    } catch {
      // Never forward a parser error: schema defaults and upstream URL fields
      // can contain credentials. Validation failures stay generic at this edge.
      this.emit({ type: 'error', scope: 'command', code: 'native_elicitation_refused',
        liftsWhen: 'The native server must send a supported elicitation mode and schema; retry with a supported request after the server or host adapter is corrected.',
        message: 'The native elicitation schema or mode is unsupported', recoverable: true });
      return { action: 'cancel' };
    }
  }

  handleClaude(toolName: string, input: Record<string, unknown>, turnId: string,
    options: Parameters<CanUseTool>[2]): ReturnType<CanUseTool> {
    const fingerprint = createHash('sha256').update(JSON.stringify([toolName, input, turnId, options.toolUseID, options.suggestions])).digest('hex');
    const seen = this.claudeTools.get(options.requestId);
    if (seen) {
      if (seen.fingerprint === fingerprint) return seen.result;
      seen.abort.abort();
      seen.result = Promise.resolve({ behavior: 'deny', message: 'Native request ID was reused with different content' });
      return seen.result;
    }
    const abort = new AbortController(), cancel = () => abort.abort();
    if (options.signal.aborted) cancel();
    options.signal.addEventListener('abort', cancel, { once: true });
    const result = this.runClaudeTool(toolName, input, turnId, { ...options, signal: abort.signal })
      .finally(() => options.signal.removeEventListener('abort', cancel));
    this.claudeTools.set(options.requestId, { fingerprint, abort, result });
    return result;
  }

  private async runClaudeTool(toolName: string, input: Record<string, unknown>, turnId: string,
    options: Parameters<CanUseTool>[2]): ReturnType<CanUseTool> {
    const epoch = this.epoch;
    const deny = (message = 'The PUI response was declined or cancelled') => ({ behavior: 'deny' as const, message });
    try {
      if (options.signal.aborted) return deny();
      // A deferred MCP wrapper can carry a native AskUserQuestion request. It
      // cannot execute that client-local tool, so ask through the same PUI card
      // and return the owner's answer to Claude as the denied wrapper result.
      // Otherwise the owner sees a generic "Allow tools_invoke?" permission
      // whose raw JSON offers no way to choose an answer.
      if (toolName === 'mcp__papercusp-su__tools_invoke' && input.name === 'AskUserQuestion') {
        const answered = await this.runClaudeTool('AskUserQuestion', record(input.args), turnId, options);
        if (!answered || answered.behavior !== 'allow') return answered ?? deny();
        const answers = record(record(answered).updatedInput).answers;
        return deny(`PUI answered AskUserQuestion: ${JSON.stringify(answers)}. The answer source is not established by this card result; do not attribute it to the owner without separate human provenance. The MCP wrapper cannot execute this native tool; continue using the recorded answer without asking again.`);
      }
      if (toolName !== 'AskUserQuestion') {
        // P-008: a readable question and the change itself; the raw arguments
        // ride as the card's details, shown only behind the PUI's Ctrl+R.
        const view = approvalCardText(toolName, input, {
          title: options.title, description: options.description, decisionReason: options.decisionReason, cwd: this.cwd });
        // Option 2, the broader remembered permission, exists only when Claude
        // offers one (PUBLIC_RELEASE_UX, Approvals; D-028).
        const remembered = sessionAllowRules(options.suggestions);
        const answer = await this.askApproval(turnId, { title: view.title, question: view.question, body: view.body,
          details: view.details, always: rememberedApprovalLabel(remembered) }, 'Claude', options.signal);
        if (epoch !== this.epoch || options.signal.aborted || answer === null) return deny();
        if (answer === 'yes') return { behavior: 'allow', updatedInput: input };
        if (answer === 'always' && remembered.length) {
          if (remembered.some((update) => update.type === 'setMode')) this.options.approvalsChanged?.('auto-edit');
          return { behavior: 'allow', updatedInput: input, updatedPermissions: remembered };
        }
        return { behavior: 'deny', message: REJECTED_TOOL_MESSAGE, interrupt: true };
      }
      const questions = z.array(z.object({
        question: z.string().min(1), multiSelect: z.boolean().optional(),
        options: z.array(z.object({ label: z.string().min(1), description: z.string().optional(), preview: z.string().optional() })).min(1),
      })).min(1).max(4).parse(input.questions);
      if (new Set(questions.map((question) => question.question)).size !== questions.length) {
        throw new Error('Claude questions must have distinct prompts');
      }
      const answers: Record<string, string> = {};
      for (const question of questions) {
        if (epoch !== this.epoch || options.signal.aborted) return deny();
        let other = 'Type a different answer';
        while (question.options.some((option) => option.label === other)) other += '…';
        const choices = question.options.map((option) => ({ label: option.label,
          description: [option.description, option.preview].filter(Boolean).join('\n') }));
        const picks = await this.askAnswers(turnId, question.question, [...choices, { label: other }], question.multiSelect, options.signal);
        if (epoch !== this.epoch || options.signal.aborted) return deny();
        if (!picks) return deny(SKIPPED_QUESTION_MESSAGE);
        const selected = picks.filter((pick) => pick !== other);
        if (picks.includes(other)) {
          const custom = await this.askAnswers(turnId, question.question, undefined, false, options.signal);
          if (epoch !== this.epoch || options.signal.aborted) return deny();
          if (!custom) return deny(SKIPPED_QUESTION_MESSAGE);
          selected.push(...custom);
        }
        answers[question.question] = selected.join(', ');
      }
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', scope: 'command', code: 'native_question_failed', message, recoverable: true });
      return deny(message);
    }
  }

  /** True means this is a supported native request, now waiting for PUI input. */
  handle(backend: 'codex' | 'omp', frame: RpcFrame, turnId: string, reply: (frame: RpcFrame) => void): boolean {
    const method = text(frame.method), params = record(frame.params), epoch = this.epoch;
    let run: (() => Promise<RpcFrame>) | undefined;
    let stopAfterReply = false;
    if (backend === 'codex' && frame.id != null) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval'].includes(method)) {
        // D-028, mapped to Codex's own decisions: option 2 is acceptForSession,
        // and No (or Esc) is `cancel`, which also stops the turn the way stock
        // Codex's "No, and tell Codex what to do differently" does.
        run = async () => {
          const files = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval';
          const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
          const command = legacy && Array.isArray(params.command) ? params.command.map(text).join(' ') : text(params.command);
          const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
          if (available && !available.some(decision => decision === 'cancel' || decision === 'decline')) {
            throw new Error('Unsupported native approval decisions');
          }
          const body = [params.reason ? `Reason: ${text(params.reason)}` : '', command ? `$ ${command}` : '',
            params.cwd ? `Directory: ${displayPath(text(params.cwd), this.cwd)}` : '',
            params.grantRoot ? `Requested write root: ${displayPath(text(params.grantRoot), this.cwd)}` : '',
            params.fileChanges ? JSON.stringify(params.fileChanges, null, 2) : '',
            params.networkApprovalContext ? JSON.stringify(params.networkApprovalContext, null, 2) : '',
            params.additionalPermissions ? JSON.stringify(params.additionalPermissions, null, 2) : '',
          ].filter(Boolean);
          const answer = await this.askApproval(turnId, {
            title: files ? 'Edit files' : `Bash(${command.length > 60 ? `${command.slice(0, 59)}…` : command})`,
            question: files ? 'Do you want to make these edits?' : 'Do you want to run this command?', body,
            accept: !available || available.includes('accept'),
            always: legacy || available && !available.includes('acceptForSession') ? undefined
              : files ? "Yes, and don't ask again for these files this session" : "Yes, and don't ask again for this command this session",
          }, 'Codex');
          return { id: frame.id, result: { decision: legacy ? answer === 'yes' ? 'approved' : 'abort'
            : answer === 'yes' ? 'accept' : answer === 'always' ? 'acceptForSession'
              : !available || available.includes('cancel') ? 'cancel' : 'decline' } };
        };
      } else if (method === 'item/permissions/requestApproval') {
        run = async () => {
          const permissions = requestedPermissions.parse(params.permissions);
          const answer = await this.askApproval(turnId, {
            title: 'Additional permissions', question: 'Allow these permissions?',
            body: [text(params.reason), params.cwd ? `Directory: ${displayPath(text(params.cwd), this.cwd)}` : '',
              JSON.stringify(permissions, null, 2)].filter(Boolean),
            always: 'Yes, for this session',
          }, 'Codex');
          return { id: frame.id, result: { permissions: answer === 'yes' || answer === 'always'
            ? Object.fromEntries(Object.entries(permissions).filter(([, value]) => value != null)) : {},
          scope: answer === 'always' ? 'session' : 'turn' } };
        };
      } else if (method === 'mcpServer/elicitation/request') {
        run = async () => {
          const result = await this.elicit(params as Parameters<OnElicitation>[0], turnId);
          return { id: frame.id, result: { ...result, content: result && 'content' in result ? result.content : null, _meta: null } };
        };
      } else if (method === 'item/tool/requestUserInput') {
        run = async () => {
          // Validate the entire request before opening the first card: a bad
          // later question must not turn an earlier answer into partial consent.
          const questions = nativeQuestions.parse(params.questions);
          const answers: Record<string, { answers: string[] }> = {};
          for (const question of questions) {
            if (epoch !== this.epoch) return { id: frame.id, result: { answers: {} } };
            let other = 'Type a different answer';
            while (question.options?.some(option => option.label === other)) other += '…';
            const choices = !question.isSecret && question.options?.length ? [...question.options,
              ...(question.isOther ? [{ label: other }] : [])] : undefined;
            const privateAnswer = question.isSecret ? await this.openCard(turnId, question.question, undefined, false,
              undefined, undefined, undefined, { sensitive: true }) : undefined;
            const picked = question.isSecret ? privateAnswer?.action === 'submit' ? privateAnswer.values : null
              : await this.askAnswers(turnId, question.question, choices, question.multiSelect);
            if (!picked || epoch !== this.epoch) return { id: frame.id, result: { answers: {} } };
            const selected = choices ? picked.filter(pick => pick !== other) : picked;
            if (choices && picked.includes(other)) {
              const custom = await this.askAnswers(turnId, question.question);
              if (!custom || epoch !== this.epoch) return { id: frame.id, result: { answers: {} } };
              selected.push(...custom);
            }
            Object.defineProperty(answers, question.id, { value: { answers: selected }, enumerable: true });
          }
          return { id: frame.id, result: { answers } };
        };
      }
    } else if (backend === 'omp' && frame.type === 'extension_ui_request' && typeof frame.id === 'string') {
      if (method === 'confirm') run = async () => ({ type: 'extension_ui_response', id: frame.id,
        confirmed: await this.ask(turnId, [text(frame.title), text(frame.message)].filter(Boolean).join('\n'), ['Confirm', 'Decline']) === 'Confirm' });
      else if (method === 'select' && text(frame.title).startsWith('Allow tool: ')
        && JSON.stringify(frame.options) === JSON.stringify(['Approve', 'Deny'])) {
        // D-028: OMP's always-ask approval (`ui.select(text, ['Approve','Deny'])`
        // in OMP's tool runner). OMP cannot remember a choice, so option 2 is
        // remembered here for this runtime: an edit-type tool by name, a
        // command tool only for the exact same request.
        const [head = '', ...rest] = text(frame.title).split('\n');
        const tool = head.slice('Allow tool: '.length).trim();
        const command = OMP_COMMAND_TOOL.test(tool);
        const key = command ? text(frame.title) : `tool:${tool}`;
        if (this.ompAllowed.has(key)) {
          reply({ type: 'extension_ui_response', id: frame.id, value: 'Approve' });
          return true;
        }
        // The detail lines are OMP's own formatApprovalDetails: `File: <path>`
        // (edit), `Path:` + `Content:` (write), `Command: <cmd>` (bash).
        const detail = (label: string) => rest.map((line) => new RegExp(`^${label}: (.+)$`).exec(line.trim())?.[1]).find(Boolean);
        const rawFile = detail('(?:File|Path)'), commandText = detail('Command');
        const file = rawFile ? displayPath(rawFile, this.cwd) : undefined;
        const named = ({ edit: 'Update', write: 'Write', bash: 'Bash', read: 'Read' } as Record<string, string>)[tool.toLowerCase()] ?? tool;
        const editing = /^(edit|write|patch|apply)/i.test(tool);
        const target = file ?? (commandText && commandText.length > 60 ? `${commandText.slice(0, 59)}…` : commandText);
        run = async () => {
          const answer = await this.askApproval(turnId, {
            title: target ? `${named}(${target})` : named,
            question: command ? 'Do you want to run this command?' : editing ? `Do you want to make this edit to ${file ?? 'this file'}?` : 'Do you want to proceed?',
            // The change shown once: the line the title already names is dropped.
            body: rest.filter((line) => line.trim() && !(file && rawFile && [`File: ${rawFile}`, `Path: ${rawFile}`].includes(line.trim()))),
            always: command ? "Yes, and don't ask again for this command this session" : `Yes, and don't ask again for ${named} this session`,
          }, 'OMP');
          if (answer === 'always') this.ompAllowed.add(key);
          if (answer === 'no') stopAfterReply = true;
          return answer === null ? { type: 'extension_ui_response', id: frame.id, cancelled: true }
            : { type: 'extension_ui_response', id: frame.id, value: answer === 'no' ? 'Deny' : 'Approve' };
        };
      }
      else if (method === 'select' || method === 'input' || method === 'editor') run = async () => {
        const choices = method === 'select' && Array.isArray(frame.options) ? frame.options.map(text) : undefined;
        const value = await this.ask(turnId, text(frame.title) || 'Your response', choices);
        return { type: 'extension_ui_response', id: frame.id, ...(value === null ? { cancelled: true } : { value }) };
      };
      else if (method === 'cancel') { this.cancel(); return true; }
    }
    if (!run) return false;
    if (backend === 'codex') {
      const key = `${typeof frame.id}:${frame.id}`, fingerprint = createHash('sha256').update(JSON.stringify([method, turnId, params])).digest('hex');
      const seen = this.codexRequests.get(key);
      if (seen !== undefined) {
        if (seen !== fingerprint) {
          this.conflictingCodexRequests.add(key);
          reply({ id: frame.id, error: { code: -32602, message: 'Native request ID was reused with different content' } });
        }
        return true;
      }
      this.codexRequests.set(key, fingerprint);
    }
    void run().then((response) => {
      if (backend === 'codex' && this.conflictingCodexRequests.has(`${typeof frame.id}:${frame.id}`)) return;
      reply(epoch === this.epoch ? response : backend === 'codex'
        ? { id: frame.id, result: method === 'mcpServer/elicitation/request' ? { action: 'cancel', content: null, _meta: null }
          : method === 'item/tool/requestUserInput' ? { answers: {} }
          : method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' }
            : { decision: ['execCommandApproval', 'applyPatchApproval'].includes(method) ? 'abort' : 'cancel' } }
        : { type: 'extension_ui_response', id: frame.id, cancelled: true });
      // OMP's "Deny" only fails the one tool call; No also stops the turn so
      // the owner says what to do instead (D-028), after OMP has the answer.
      if (stopAfterReply) this.options.stopTurn?.();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', scope: 'command', code: 'native_question_failed', message, recoverable: true });
      reply(backend === 'codex' ? { id: frame.id, error: { code: -32602, message } }
        : { type: 'extension_ui_response', id: frame.id, cancelled: true });
    });
    return true;
  }
}
