// Prompt builder for AI tools - constructs contextual prompts with pipeline execution data

/** Same shape as the execution links the rest of the extension opens. Works for CI and CD. */
export function buildExecutionUrl(context: {
  baseUrl: string;
  accountId: string;
  org: string;
  project: string;
  pipelineIdentifier: string;
  planExecutionId: string;
}): string {
  const { baseUrl, accountId, org, project, pipelineIdentifier, planExecutionId } = context;
  return `${baseUrl}/ng/account/${accountId}/all/orgs/${org}/projects/${project}/pipelines/${pipelineIdentifier}/deployments/${planExecutionId}/pipeline`;
}

interface ExecutionContext {
  pipelineIdentifier?: string;
  planExecutionId?: string;
  accountId?: string;
  org?: string;
  project?: string;
  baseUrl?: string;
}

/**
 * Build a contextual prompt for AI tools
 * Includes pipeline execution data, error context, and user question
 */
export function buildPrompt(userQuestion: string, context?: ExecutionContext): string {
  const parts: string[] = [];

  // If no context provided, return just the question
  if (!context) {
    return userQuestion;
  }

  // Build Harness URL if we have all required info
  if (context.baseUrl && context.accountId && context.org && context.project && context.pipelineIdentifier && context.planExecutionId) {
    const executionUrl = buildExecutionUrl({
      baseUrl: context.baseUrl,
      accountId: context.accountId,
      org: context.org,
      project: context.project,
      pipelineIdentifier: context.pipelineIdentifier,
      planExecutionId: context.planExecutionId,
    });

    // Start with the FIRST action - calling harness_get immediately
    parts.push(`Call harness_get with this Harness execution URL to get the full execution details:\n${executionUrl}`);
    parts.push(`\nThen use that data to answer this question: ${userQuestion}`);
    parts.push(`\nDo NOT ask for more information - the URL above has everything you need.`);
  } else if (context.planExecutionId) {
    parts.push(`Call harness_get with resourceType='execution' and executionId='${context.planExecutionId}' (org='${context.org}', project='${context.project}') to get the execution details.`);
    parts.push(`\nThen answer this question: ${userQuestion}`);
  } else {
    return userQuestion;
  }

  return parts.join('\n');
}

const TERMINAL_SURFACE =
  "You're running in the VS Code integrated terminal, launched by the Harness extension.";

/** Stay under typical argv limits before shell quoting expands the text. */
const TERMINAL_PROMPT_BYTE_BUDGET = 96 * 1024;
const TRUNCATION_MARKER = ' …';

/** Drop terminal-injection controls while keeping newlines and tabs. */
export function sanitizePromptText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  const budget = Math.max(0, maxBytes - markerBytes);
  let end = budget;
  while (end > 0 && (encoded[end] & 0b11000000) === 0b10000000) {
    end -= 1;
  }
  return encoded.subarray(0, end).toString('utf8').trimEnd() + TRUNCATION_MARKER;
}

/**
 * Structured prompt for an interactive Claude CLI session.
 * The execution URL is the context; Claude loads the details through Harness MCP.
 */
export function buildClaudeTerminalPrompt(userQuestion: string, context?: ExecutionContext): string {
  const question = sanitizePromptText(userQuestion).trim();
  const quoted = (question || 'Help me understand this Harness pipeline.')
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');

  let body: string;
  if (context?.baseUrl && context.accountId && context.org && context.project && context.pipelineIdentifier && context.planExecutionId) {
    const executionUrl = buildExecutionUrl({
      baseUrl: context.baseUrl,
      accountId: context.accountId,
      org: context.org,
      project: context.project,
      pipelineIdentifier: context.pipelineIdentifier,
      planExecutionId: context.planExecutionId,
    });
    body = [
      TERMINAL_SURFACE,
      '',
      'Call harness_get with this Harness execution URL:',
      executionUrl,
      '',
      'Then answer this question:',
      '',
      quoted,
      '',
      'Do not ask for account, org, or project. The URL has everything you need.',
    ].join('\n');
  } else if (context?.planExecutionId) {
    body = [
      TERMINAL_SURFACE,
      '',
      `Call harness_get with resourceType='execution' and executionId='${context.planExecutionId}' (org='${context.org ?? ''}', project='${context.project ?? ''}') to get the execution details.`,
      '',
      'Then answer this question:',
      '',
      quoted,
    ].join('\n');
  } else {
    body = [TERMINAL_SURFACE, '', 'Answer this question:', '', quoted].join('\n');
  }

  return truncateUtf8(sanitizePromptText(body), TERMINAL_PROMPT_BYTE_BUDGET);
}
