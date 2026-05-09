import { HarnessConfig } from '../config/configManager';

export async function submitApproval(
  config: HarnessConfig,
  planExecutionId: string,
  action: 'APPROVE' | 'REJECT',
  comments?: string
): Promise<void> {
  const url = `${config.baseUrl}/gateway/pipeline/api/v1/orgs/${encodeURIComponent(config.orgIdentifier)}/projects/${encodeURIComponent(config.projectIdentifier)}/approvals/execution/${encodeURIComponent(planExecutionId)}`;

  // Add timeout to prevent hanging
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for approval submission

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Harness-Account': config.accountIdentifier,
        'x-api-key': config.apiKey,
      },
      body: JSON.stringify({ action, comments: comments ?? '', approver_inputs: [] }),
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
