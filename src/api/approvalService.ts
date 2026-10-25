import { HarnessConfig } from '../config/configManager';
import {
  approvalActivityUrl,
  approvalInstancesUrl,
  parseApprovalInstances,
  selectApprovalInstanceId,
} from './approvalInstances';

export async function submitApproval(
  config: HarnessConfig,
  planExecutionId: string,
  action: 'APPROVE' | 'REJECT',
  options?: { comments?: string; nodeExecutionId?: string; approvalInstanceId?: string }
): Promise<void> {
  const approvalInstanceId = options?.approvalInstanceId
    || await resolveWaitingInstanceId(config, planExecutionId, options?.nodeExecutionId);

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
        comments: options?.comments ?? '',
        approverInputs: [],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function resolveWaitingInstanceId(
  config: HarnessConfig,
  planExecutionId: string,
  nodeExecutionId?: string,
): Promise<string> {
  if (!nodeExecutionId) {
    throw new Error('Could not identify which approval step to update.');
  }

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
    clearTimeout(timeoutId);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const instanceId = selectApprovalInstanceId(parseApprovalInstances(await res.json()), nodeExecutionId);
    if (!instanceId) {
      throw new Error('Could not identify a single waiting approval for this step.');
    }
    return instanceId;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
