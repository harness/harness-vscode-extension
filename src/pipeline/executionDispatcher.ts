import { HarnessClient } from '../api/harnessClient';
import { HarnessConfig } from '../config/configManager';
import { DiagnosticsManager } from '../features/diagnosticsManager';
import { WebviewBridge } from '../ui/webviewBridge';
import { ExecutionDetail, ExecutionGraph } from '../api/types';
import { GitContext } from '../git/gitContext';
import { streamLogs, findActiveStage, findActiveSteps, findLeafStepsWithLogKey, fetchStepLogs } from '../api/logService';
// STO imports - disabled for now
// import { getStoFindings } from '../api/stoService';
// import { applySTO, summariseSTO } from '../features/stoAnnotations';
import { getTiOverview, getFlakyTests } from '../api/tiService';
import { applyTI, summariseTI } from '../features/tiAnnotations';
import { getSscaSbom } from '../api/sscaService';
import { applySSCA, summariseSSCA } from '../features/sscaAnnotations';
// AIDA imports - disabled (endpoint 404)
// import { getAidaRca } from '../api/aidaService';
import { getBuildCost } from '../api/ccmService';
import { parseStoScan } from '../api/stoScan';
import { canCurrentUserApprove } from '../api/userService';
import { logger } from '../utils/logger';

export async function dispatchModules(
  execution: ExecutionDetail,
  executionGraph: ExecutionGraph | null,
  client: HarnessClient,
  config: HarnessConfig,
  diagnostics: DiagnosticsManager,
  webview: WebviewBridge,
  ctx?: GitContext,
  harnessUrl?: string,
  executionTriggerInfo?: { triggerType?: string; triggeredBy?: { identifier?: string; email?: string; triggerIdentifier?: string } }
): Promise<void> {
  const { moduleInfo, planExecutionId } = execution;
  // Normalize status to uppercase for consistent comparison
  const status = execution.status.toUpperCase();
  const isTerminal = ['SUCCESS','FAILED','ABORTED','EXPIRED','IGNOREFAILED','POLICY_EVALUATION_FAILURE'].includes(status);
  // Fetch logs for terminal executions AND for ApprovalWaiting (so previous steps can be viewed)
  const shouldFetchLogs = isTerminal || status === 'APPROVALWAITING';

  logger.debug('Harness', 'dispatchModules status check:', {
    rawStatus: execution.status,
    normalizedStatus: status,
    isTerminal,
    shouldFetchLogs,
    willCheckApprovals: !isTerminal && status === 'APPROVALWAITING'
  });

  // Always push execution state + graph to webview (with normalized status)
  const normalizedExecution = { ...execution, status, executionTriggerInfo };
  webview.send({
    type: 'EXECUTION_UPDATE',
    execution: normalizedExecution,
    executionGraph,
    isTerminal,
    harnessUrl,
    commitWebUrl: ctx?.commitWebUrl,
  });

  // CI: fetch logs via blob/download (terminal) or stream (active)
  if (moduleInfo.ci) {
    const layoutNodeMap = execution.layoutNodeMap ?? {};

    if (shouldFetchLogs) {
      // Check FME variation to decide if we should pre-load logs
      const { getLogViewerVariation } = await import('../fme/fmeClient');
      const variation = await getLogViewerVariation();

      if (variation === 'inline') {
        // Inline mode: pre-fetch logs for all steps and send to webview
        // This allows instant display when user clicks a step
        const steps = findLeafStepsWithLogKey(executionGraph);
        if (steps.length > 0) {
          let anyLogs = false;
          await Promise.all(steps.map(async step => {
            const lines = await fetchStepLogs(config, step.logBaseKey).catch(() => [] as string[]);
            if (lines.length > 0) {
              anyLogs = true;
              webview.send({ type: 'LOG_CHUNK', nodeId: step.nodeId, lines, autoExpand: false });
            }
          }));
          if (!anyLogs) webview.send({ type: 'LOGS_UNAVAILABLE' });
        }
      }
      // Expanded mode: don't pre-fetch logs
      // Logs will be fetched on-demand when user clicks a step
      // and will open in editor tab instead of webview
    }
    // Note: For running executions, logs are fetched on-demand when the user clicks a step
    // (handled by the fetchStepLogs message handler in extension.ts)
    // Automatic streaming was removed to prevent API spam and unnecessary log fetching
  }

  // CD: deployment status
  if (moduleInfo.cd) {
    try {
      const deployments = await client.post('/pipeline/api/pipelines/execution/summary', {
        filterType: 'PipelineExecution',
        moduleProperties: { cd: {} },
      });
      webview.send({ type: 'CD_UPDATE', deployments });
    } catch (e) {
      logger.error('Harness', 'CD dispatch error:', e);
    }
  }

  // STO: vulnerability counts parsed from the execution graph (NOT the issues API).
  // executionGraph is already in hand — no fetch. The per-CVE issue list lives
  // behind /sto/api/v1/issues (getStoFindings/applySTO, still disabled) and is a
  // separate concern; this only surfaces the aggregate severity counts + deltas.
  try {
    // STO deep-link shares the execution URL but ends in /security instead of
    // /pipeline (e.g. .../deployments/{planExecutionId}/security).
    const stoUrl = harnessUrl
      ? harnessUrl.replace(/\/pipeline$/, '/security')
      : undefined;
    const stoScan = parseStoScan(executionGraph, planExecutionId, stoUrl);
    if (stoScan) {
      webview.send({ type: 'STO_SCAN', stoScan });
    }
  } catch (e) {
    logger.error('Harness', 'STO scan parse error:', e);
  }

  // TI: test results + flaky flags
  if (moduleInfo.ti) {
    try {
      const [overview, flaky] = await Promise.all([
        getTiOverview(client, planExecutionId),
        getFlakyTests(client, config),
      ]);
      applyTI(overview, flaky, diagnostics);
      webview.send({ type: 'TI_SUMMARY', ...summariseTI(overview, flaky) });
    } catch (e) {
      logger.error('Harness', 'TI dispatch error:', e);
    }
  }

  // SSCA: supply chain component flags
  if (moduleInfo.ssca) {
    try {
      const sbom = await getSscaSbom(client, planExecutionId);
      applySSCA(sbom, diagnostics);
      webview.send({ type: 'SSCA_SUMMARY', ...summariseSSCA(sbom) });
    } catch (e) {
      logger.error('Harness', 'SSCA dispatch error:', e);
    }
  }

  // OPA: policy evaluation — extract from governanceMetadata embedded in the
  // execution detail response (no separate API call needed)
  if (execution.governanceMetadata) {
    const gm = execution.governanceMetadata;
    const policyUrl = harnessUrl
      ? harnessUrl.replace(/\/pipeline$/, '') + '/policy-evaluations'
      : undefined;
    const policy: import('../api/types').PolicyEvaluation = {
      status: gm.status ?? 'UNKNOWN',
      details: (gm.details ?? []).flatMap(policySet =>
        (policySet.policyMetadata ?? []).map(p => ({
          policyName: p.policyName ?? policySet.policySetName ?? 'Policy',
          status:     p.status ?? 'UNKNOWN',
          denyMessages: p.denyMessages,
        }))
      ),
      policyUrl,
    };
    webview.send({ type: 'OPA_UPDATE', policy });
  }

  // Approval: detect APPROVAL_WAITING stage and fetch instance details
  if (!isTerminal && status === 'APPROVALWAITING') {
    try {
      const allNodes = Object.values(executionGraph?.nodeMap ?? {});

      // Debug: Log all nodes with approval-related types or waiting status
      const approvalLikeNodes = allNodes.filter(n =>
        n.stepType?.toLowerCase().includes('approval') || /waiting/i.test(n.status)
      );
      if (approvalLikeNodes.length > 0) {
        logger.debug('Harness', 'Approval detection - found nodes:', approvalLikeNodes.map(n => ({
          name: n.name,
          stepType: n.stepType,
          status: n.status,
          baseFqn: (n as any).baseFqn
        })));
      }

      // Check for Harness native approval
      const harnessApprovalNode = allNodes.find(
        n => (n.stepType === 'HarnessApproval' || n.stepType === 'HARNESS_APPROVAL') &&
             /waiting|running/i.test(n.status)
      );

      // Check for Jira approval
      const jiraApprovalNode = allNodes.find(
        n => n.stepType === 'JiraApproval' && /waiting|running/i.test(n.status)
      );

      // Check for ServiceNow approval
      const serviceNowApprovalNode = allNodes.find(
        n => n.stepType === 'ServiceNowApproval' && /waiting|running/i.test(n.status)
      );

      // Generic fallback: any step with "Approval" in stepType and waiting status
      const genericApprovalNode = !harnessApprovalNode && !jiraApprovalNode && !serviceNowApprovalNode
        ? allNodes.find(n => n.stepType?.includes('Approval') && /waiting|running/i.test(n.status))
        : undefined;

      if (harnessApprovalNode || genericApprovalNode) {
        const n = (harnessApprovalNode || genericApprovalNode) as any;

        logger.debug('Harness', 'Found approval node:', {
          name: n.name,
          stepType: n.stepType,
          status: n.status,
          baseFqn: n.baseFqn,
          hasSpec: !!n.stepParameters?.spec
        });

        // Display info is embedded in stepParameters
        const spec = n?.stepParameters?.spec ?? {};
        const rawUsers: Array<{ uuid?: string; email?: string }> = spec?.approvers?.users ?? [];
        const rawGroups: string[] = spec?.approvers?.userGroups ?? [];
        const userGroups: string[] = rawGroups.map((g: string) => g.replace(/^_project_/, '').replace(/_/g, ' '));
        const approvers: string[]  = rawUsers.map((u: any) => u.name ?? u.email ?? u).filter(Boolean);
        const minimumCount: number = spec?.approvers?.minimumCount ?? 1;

        // Find which stage contains this approval step by traversing up the baseFqn
        // Example baseFqn: "pipeline.stages.Deploy_Dev.spec.execution.steps.promotionApproval"
        const baseFqn = n.baseFqn || '';
        const stageIdMatch = baseFqn.match(/pipeline\.stages\.([^.]+)/);
        const stageIdentifier = stageIdMatch ? stageIdMatch[1] : undefined;

        logger.debug('Harness', 'Approval details:', {
          stageIdentifier,
          approvers,
          userGroups,
          minimumCount
        });

        // Check if the current user is allowed to approve
        const canApprove = await canCurrentUserApprove(config, rawUsers, rawGroups)
          .catch(() => null); // null = unknown → webview defaults to showing buttons

        logger.debug('Harness', 'Sending APPROVAL_UPDATE to webview:', {
          planExecutionId,
          stageIdentifier,
          canApprove
        });

        webview.send({
          type: 'APPROVAL_UPDATE',
          planExecutionId,
          approvers,
          userGroups,
          minimumCount,
          deadline: undefined,
          canApprove: canApprove ?? true, // default to showing buttons when undetermined
          stageIdentifier, // Include stage identifier so webview knows where to render the card
        });
      } else if (jiraApprovalNode) {
        const n = jiraApprovalNode as any;
        const spec = n?.stepParameters?.spec ?? {};

        // Extract Jira ticket information
        const issueKey = spec?.issueKey ?? '';
        const projectKey = spec?.projectKey ?? '';
        const issueType = spec?.issueType ?? '';
        const approvalCriteria = spec?.approvalCriteria?.criteriaSpec?.conditions ?? [];
        const rejectionCriteria = spec?.rejectionCriteria?.criteriaSpec?.conditions ?? [];

        // Find which stage contains this approval step
        const baseFqn = n.baseFqn || '';
        const stageIdMatch = baseFqn.match(/pipeline\.stages\.([^.]+)/);
        const stageIdentifier = stageIdMatch ? stageIdMatch[1] : undefined;

        // Try to construct Jira URL - this may need connector lookup for the actual Jira instance URL
        // For now, we'll send the issue key and let the webview handle it
        const jiraUrl = issueKey ? `https://harness.atlassian.net/browse/${issueKey}` : undefined;

        webview.send({
          type: 'EXTERNAL_APPROVAL_UPDATE',
          planExecutionId,
          approvalType: 'Jira',
          ticketId: issueKey,
          ticketUrl: jiraUrl,
          projectKey,
          issueType,
          approvalCriteria: approvalCriteria.map((c: any) => `${c.key} ${c.operator} ${c.value}`).join(', '),
          rejectionCriteria: rejectionCriteria.map((c: any) => `${c.key} ${c.operator} ${c.value}`).join(', '),
          stageIdentifier,
        });
      } else if (serviceNowApprovalNode) {
        const n = serviceNowApprovalNode as any;
        const spec = n?.stepParameters?.spec ?? {};

        // Extract ServiceNow ticket information
        const ticketNumber = spec?.ticketNumber ?? spec?.issueNumber ?? '';
        const ticketType = spec?.ticketType ?? '';
        const approvalCriteria = spec?.approvalCriteria?.criteriaSpec?.conditions ?? [];
        const rejectionCriteria = spec?.rejectionCriteria?.criteriaSpec?.conditions ?? [];

        // Find which stage contains this approval step
        const baseFqn = n.baseFqn || '';
        const stageIdMatch = baseFqn.match(/pipeline\.stages\.([^.]+)/);
        const stageIdentifier = stageIdMatch ? stageIdMatch[1] : undefined;

        // ServiceNow URL would need connector lookup for the instance URL
        const serviceNowUrl = ticketNumber ? `https://instance.service-now.com/nav_to.do?uri=${ticketType}/${ticketNumber}` : undefined;

        webview.send({
          type: 'EXTERNAL_APPROVAL_UPDATE',
          planExecutionId,
          approvalType: 'ServiceNow',
          ticketId: ticketNumber,
          ticketUrl: serviceNowUrl,
          ticketType,
          approvalCriteria: approvalCriteria.map((c: any) => `${c.key} ${c.operator} ${c.value}`).join(', '),
          rejectionCriteria: rejectionCriteria.map((c: any) => `${c.key} ${c.operator} ${c.value}`).join(', '),
          stageIdentifier,
        });
      } else {
        logger.debug('Harness', 'No approval node found matching criteria');
      }
    } catch (e) {
      logger.error('Harness', 'Approval dispatch error:', e);
    }
  }

  // AIDA: root cause analysis on any failed stage — DISABLED (endpoint returns 404)
  // const layoutNodeMap = execution.layoutNodeMap ?? {};
  // const failedStage = findFailedStage(layoutNodeMap);
  // if (failedStage) {
  //   try {
  //     const rca = await getAidaRca(client, config, planExecutionId, failedStage.nodeUuid);
  //     webview.send({ type: 'AIDA_UPDATE', stageId: failedStage.nodeUuid, rca });
  //   } catch (e) {
  //     console.error('[Harness] AIDA dispatch error:', e);
  //   }
  // }

  // CCM: build cost — best-effort, silent skip on failure
  if (moduleInfo.ccm) {
    try {
      const cost = await getBuildCost(client, planExecutionId);
      webview.send({ type: 'CCM_UPDATE', cost });
    } catch {
      // CCM data may lag — never surface as error
    }
  }
}
