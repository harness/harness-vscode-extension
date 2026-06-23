import { HarnessConfig } from '../config/configManager';
import { logger } from '../utils/logger';

export type InterruptType = 'AbortAll' | 'UserMarkedFailure';

export async function abortExecution(
  config: HarnessConfig,
  planExecutionId: string,
  interruptType: InterruptType
): Promise<void> {
  logger.info('AbortService', 'Aborting execution', { planExecutionId, interruptType });

  const params = new URLSearchParams({
    accountIdentifier: config.accountIdentifier,
    orgIdentifier: config.orgIdentifier,
    projectIdentifier: config.projectIdentifier,
    interruptType,
  });

  const url = `${config.baseUrl}/pipeline/api/pipeline/execute/interrupt/${encodeURIComponent(planExecutionId)}?${params.toString()}`;

  // Add timeout to prevent hanging
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for interrupt

  try {
    const res = await fetch(url, {
      method: 'PUT',
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
      logger.error('AbortService', 'Interrupt API failed', {
        status: res.status,
        response: text.slice(0, 500),
      });
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    logger.info('AbortService', 'Execution interrupt submitted successfully');
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
