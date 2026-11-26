import { HarnessConfig } from '../config/configManager';
import {
  approvalActivityUrl,
  approvalInstancesUrl,
  parseApprovalInstances,
  parseWaitingApproval,
  selectApprovalInstanceId,
  type ApproverInputField,
} from './approvalInstances';

export const approvalBack = Symbol('approvalBack');

type ApprovalInputValue = { name: string; value: string };
interface ApprovalOptions {
  comments?: string;
  nodeExecutionId?: string;
  approvalInstanceId?: string;
  promptForInput: (field: ApproverInputField, step: number, total: number, previousValue: string | undefined, canGoBack: boolean) => PromiseLike<string | typeof approvalBack | undefined>;
  reviewInputs: (values: readonly ApprovalInputValue[]) => PromiseLike<number | 'approve' | typeof approvalBack | undefined>;
}

async function collectApprovalInputs(fields: ApproverInputField[], options: ApprovalOptions): Promise<ApprovalInputValue[] | undefined> {
  if (!fields.length) return [];
  const values: ApprovalInputValue[] = [];
  let index = 0;
  let editingFromReview = false;
  for (;;) {
    if (index === fields.length) {
      const choice = await options.reviewInputs(values);
      if (choice === undefined) return undefined;
      if (choice === 'approve') return values;
      index = choice === approvalBack ? fields.length - 1 : choice;
      editingFromReview = true;
      continue;
    }

    const field = fields[index];
    const result = await options.promptForInput(field, index + 1, fields.length, values[index]?.value, editingFromReview || index > 0);
    if (result === undefined) return undefined;
    if (result !== approvalBack) values[index] = { name: field.name, value: result };
    index = editingFromReview ? fields.length : result === approvalBack ? index - 1 : index + 1;
  }
}

type ApprovalAction = 'APPROVE' | 'REJECT';
type ApprovalOutcome = 'submitted' | 'cancelled' | 'step-busy' | 'another-step-busy';

export function createApprovalRunner() {
  // Quick Input is shared across steps, so lock before starting the API lookup.
  let active: { planExecutionId: string; nodeExecutionId?: string } | undefined;
  return async (config: HarnessConfig, planExecutionId: string, action: ApprovalAction, options: ApprovalOptions): Promise<ApprovalOutcome> => {
    const { nodeExecutionId } = options;
    if (active) {
      return active.planExecutionId === planExecutionId && active.nodeExecutionId === nodeExecutionId
        ? 'step-busy' : 'another-step-busy';
    }
    active = { planExecutionId, nodeExecutionId };
    try {
      return await submitApproval(config, planExecutionId, action, options) ? 'submitted' : 'cancelled';
    } finally {
      active = undefined;
    }
  };
}

export async function submitApproval(
  config: HarnessConfig,
  planExecutionId: string,
  action: ApprovalAction,
  options: ApprovalOptions,
): Promise<boolean> {
  let approvalInstanceId: string;
  let approverInputs: ApprovalInputValue[] = [];
  if (action === 'APPROVE') {
    const approval = await loadWaitingApproval(config, planExecutionId, options);
    approvalInstanceId = approval.id;
    const collected = await collectApprovalInputs(approval.fields, options);
    if (!collected) return false;
    approverInputs = collected;
  } else {
    approvalInstanceId = options.approvalInstanceId
      || await resolveWaitingInstanceId(config, planExecutionId, options.nodeExecutionId);
  }

  const url = approvalActivityUrl(config.baseUrl, approvalInstanceId, config.accountIdentifier);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Harness-Account': config.accountIdentifier,
        'x-api-key': config.apiKey,
      },
      body: JSON.stringify({
        action,
        comments: options.comments ?? '',
        approverInputs,
      }),
      signal: controller.signal,
    }).catch(() => {
      throw new Error('Could not confirm submission. Check the execution in the Harness web UI before retrying.');
    });

    // An activity response can echo submitted values; never surface its body.
    if (!res.ok) throw new Error(`HTTP ${res.status}. Check the execution in the Harness web UI.`);
    return true;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadWaitingApproval(config: HarnessConfig, planExecutionId: string, options: ApprovalOptions) {
  try {
    if (options.nodeExecutionId) {
      const payload = await fetchWaitingInstances(config, planExecutionId, options.nodeExecutionId);
      const approval = parseWaitingApproval(payload, options.nodeExecutionId, options.approvalInstanceId);
      if (approval) return approval;
    }
  } catch {
    // Do not surface the response or underlying error; it can contain input defaults.
  }
  throw new Error('Could not verify the input requirements for this waiting step. Open the execution in the Harness web UI to approve it.');
}

async function resolveWaitingInstanceId(
  config: HarnessConfig,
  planExecutionId: string,
  nodeExecutionId?: string,
): Promise<string> {
  if (!nodeExecutionId) throw new Error('Could not identify which approval step to update.');
  const payload = await fetchWaitingInstances(config, planExecutionId, nodeExecutionId);
  const instanceId = selectApprovalInstanceId(parseApprovalInstances(payload), nodeExecutionId);
  if (!instanceId) throw new Error('Could not identify a single waiting approval for this step.');
  return instanceId;
}

async function fetchWaitingInstances(config: HarnessConfig, planExecutionId: string, nodeExecutionId: string): Promise<unknown> {
  const url = approvalInstancesUrl(
    config.baseUrl,
    config.orgIdentifier,
    config.projectIdentifier,
    planExecutionId,
    nodeExecutionId,
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'Harness-Account': config.accountIdentifier,
        'x-api-key': config.apiKey,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}
