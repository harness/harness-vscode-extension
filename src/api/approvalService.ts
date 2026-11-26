import { HarnessConfig } from '../config/configManager';
import {
  approvalActivityUrl,
  approvalInstancesUrl,
  parseApprovalInstances,
  parseWaitingApproval,
  selectApprovalInstanceId,
  type ApproverInputField,
} from './approvalInstances';

interface ApprovalOptions {
  comments?: string;
  nodeExecutionId?: string;
  approvalInstanceId?: string;
  promptForInput: (field: ApproverInputField, step: number, total: number) => PromiseLike<string | undefined>;
}

export async function submitApproval(
  config: HarnessConfig,
  planExecutionId: string,
  action: 'APPROVE' | 'REJECT',
  options: ApprovalOptions,
): Promise<boolean> {
  let approvalInstanceId: string;
  const approverInputs: Array<{ name: string; value: string }> = [];
  if (action === 'APPROVE') {
    const approval = await loadWaitingApproval(config, planExecutionId, options);
    approvalInstanceId = approval.id;
    for (const [index, field] of approval.fields.entries()) {
      const value = await options.promptForInput(field, index + 1, approval.fields.length);
      if (value === undefined) return false;
      approverInputs.push({ name: field.name, value });
    }
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
