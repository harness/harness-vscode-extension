import { HarnessConfig } from '../config/configManager';
import { logger } from '../utils/logger';

export async function rerunPipeline(
  config: HarnessConfig,
  pipelineIdentifier: string,
  planExecutionId: string,
  firstStageId?: string
): Promise<{ planExecutionId: string }> {
  logger.info('RerunService', 'Rerunning pipeline', { planExecutionId, pipelineIdentifier });

  // Step 1: Fetch the inputSet YAML from the original execution
  const inputSetUrl = `${config.baseUrl}/pipeline/api/pipelines/execution/${encodeURIComponent(planExecutionId)}/inputsetV2?accountIdentifier=${encodeURIComponent(config.accountIdentifier)}&orgIdentifier=${encodeURIComponent(config.orgIdentifier)}&projectIdentifier=${encodeURIComponent(config.projectIdentifier)}&resolveExpressions=false&resolveExpressionsType=RESOLVE_ALL_EXPRESSIONS`;

  let inputSetYaml = '';
  try {
    const inputSetRes = await fetch(inputSetUrl, {
      method: 'GET',
      headers: {
        'x-api-key': config.apiKey,
        'Content-Type': 'application/yaml',
      },
    });

    if (inputSetRes.ok) {
      const inputSetData: any = await inputSetRes.json();
      inputSetYaml = inputSetData?.data?.inputSetYaml || '';
      logger.debug('RerunService', 'Fetched inputSet YAML', { length: inputSetYaml.length });
    } else {
      const errorText = await inputSetRes.text();
      logger.warn('RerunService', 'Failed to fetch inputSet YAML', {
        status: inputSetRes.status,
        error: errorText.substring(0, 200)
      });
    }
  } catch (err) {
    logger.error('RerunService', 'Error fetching inputSet YAML:', err);
  }

  // Step 2: Fetch the available retry stages from the API to get correct stage identifiers
  const retryStagesUrl = `${config.baseUrl}/pipeline/api/pipeline/execute/${encodeURIComponent(planExecutionId)}/retryStages?accountIdentifier=${encodeURIComponent(config.accountIdentifier)}&orgIdentifier=${encodeURIComponent(config.orgIdentifier)}&projectIdentifier=${encodeURIComponent(config.projectIdentifier)}&pipelineIdentifier=${encodeURIComponent(pipelineIdentifier)}`;

  let correctStageId: string | undefined;
  try {
    const stagesRes = await fetch(retryStagesUrl, {
      method: 'GET',
      headers: {
        'x-api-key': config.apiKey,
      },
    });

    if (stagesRes.ok) {
      const stagesData: any = await stagesRes.json();
      const groups = stagesData?.data?.groups || stagesData?.groups || [];
      if (groups.length > 0 && groups[0].info && groups[0].info.length > 0) {
        correctStageId = groups[0].info[0].identifier;
        logger.debug('RerunService', 'Extracted first stage identifier', { stageId: correctStageId });
      }
    }
  } catch (err) {
    logger.warn('RerunService', 'Failed to fetch retry stages:', err);
  }

  // Harness API endpoint for retrying a pipeline execution
  // Based on Harness docs: pipelineIdentifier in PATH, planExecutionId in QUERY
  const params = new URLSearchParams({
    accountIdentifier: config.accountIdentifier,
    orgIdentifier: config.orgIdentifier,
    projectIdentifier: config.projectIdentifier,
    planExecutionId: planExecutionId,
  });

  // Use the stage ID from the API if available, otherwise use the one passed in
  const stageIdToUse = correctStageId || firstStageId;
  if (stageIdToUse) {
    params.append('retryStages', stageIdToUse);
    logger.debug('RerunService', 'Using retryStages', { stageId: stageIdToUse });
  } else {
    logger.warn('RerunService', 'No stage ID available - this will likely fail');
  }

  // URL structure from Harness docs: /pipeline/api/pipeline/execute/retry/{pipelineIdentifier}
  const url = `${config.baseUrl}/pipeline/api/pipeline/execute/retry/${encodeURIComponent(pipelineIdentifier)}?${params.toString()}`;

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
      body: inputSetYaml, // Pass the inputSet YAML from the original execution
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('RerunService', 'Retry API failed', {
        status: res.status,
        response: text.slice(0, 500),
      });
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data: any = await res.json();
    const result = data?.data ?? data;
    const planExecutionId = result?.planExecution?.uuid;

    logger.info('RerunService', 'Pipeline rerun successful', { planExecutionId });

    return { planExecutionId };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
