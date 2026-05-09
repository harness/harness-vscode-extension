import { HarnessConfig } from '../config/configManager';

export async function rerunPipeline(
  config: HarnessConfig,
  pipelineIdentifier: string,
  planExecutionId: string
): Promise<{ planExecutionId: string }> {
  // Harness API endpoint for re-running a pipeline execution with original inputs (v2)
  const url = `${config.baseUrl}/pipeline/api/pipelines/execution/rerun/v2/${encodeURIComponent(planExecutionId)}/${encodeURIComponent(pipelineIdentifier)}?accountIdentifier=${encodeURIComponent(config.accountIdentifier)}&orgIdentifier=${encodeURIComponent(config.orgIdentifier)}&projectIdentifier=${encodeURIComponent(config.projectIdentifier)}&useOriginalPipelineYamlOnRerun=true`;

  // Add timeout to prevent hanging
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout for pipeline rerun

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/yaml',
        'x-api-key': config.apiKey,
      },
      body: '',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    return data?.data ?? data;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
