import { HarnessClient } from '../api/harnessClient';
import { HarnessConfig } from '../config/configManager';
import { DiagnosticsManager } from '../features/diagnosticsManager';
import { WebviewBridge } from '../ui/webviewBridge';
import { ExecutionDetail, ExecutionGraph, ExecutionNode } from '../api/types';
import { GitContext } from '../git/gitContext';
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
import { approvalInstanceIdFromNode } from '../api/approvalInstances';
import { canCurrentUserApprove } from '../api/userService';
import { formatUserGroupLabel } from '../api/userGroups';
import { stageIdFromBaseFqn } from './executionModel';
import { logger } from '../utils/logger';

function criteriaText(criteria: { criteriaSpec?: { conditions?: Array<{ key?: string; operator?: string; value?: string }> } } | undefined): string {
  return (criteria?.criteriaSpec?.conditions ?? [])
    .map(condition => `${condition.key} ${condition.operator} ${condition.value}`)
    .join(', ');
}

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

  logger.debug('Harness', 'dispatchModules status check:', {
    rawStatus: execution.status,
    normalizedStatus: status,
    isTerminal,
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

  // CI logs: fetched on-demand when the user clicks a step (extension.ts fetchStepLogs handler).

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
      webview.send({ type: 'STO_SCAN', planExecutionId, stoScan });
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

  // Approval: one card per waiting step, keyed by its graph node id.
  if (!isTerminal && status === 'APPROVALWAITING') {
    try {
      const entries = Object.entries(executionGraph?.nodeMap ?? {});
      const waiting = (matches: (node: ExecutionNode) => boolean) => entries
        .filter(([, node]) => matches(node))
        .map(([nodeId, node]) => ({ nodeId, node }));
      const isWaiting = (node: ExecutionNode) => /waiting|running/i.test(node.status ?? '');

      const approvalLikeNodes = entries
        .map(([, node]) => node)
        .filter(node => node.stepType?.toLowerCase().includes('approval') || /waiting/i.test(node.status));
      if (approvalLikeNodes.length > 0) {
        logger.debug('Harness', 'Approval detection - found nodes:', approvalLikeNodes.map(n => ({
          name: n.name,
          stepType: n.stepType,
          status: n.status,
          baseFqn: n.baseFqn,
        })));
      }

      const harnessNodes = waiting(node =>
        (node.stepType === 'HarnessApproval' || node.stepType === 'HARNESS_APPROVAL') && isWaiting(node)
      );
      const nativeNodes = harnessNodes.length > 0
        ? harnessNodes
        : waiting(node =>
          !!node.stepType?.includes('Approval') &&
          node.stepType !== 'JiraApproval' &&
          node.stepType !== 'ServiceNowApproval' &&
          isWaiting(node)
        );

      const approvals = await Promise.all(nativeNodes.map(async ({ nodeId, node }) => {
        const spec = (node.stepParameters?.spec ?? {}) as {
          approvers?: {
            users?: Array<{ uuid?: string; email?: string; name?: string }>;
            userGroups?: string[];
            minimumCount?: number;
          };
        };
        const rawUsers = spec.approvers?.users ?? [];
        const rawGroups = spec.approvers?.userGroups ?? [];
        const canApprove = await canCurrentUserApprove(config, rawUsers, rawGroups).catch(() => null);
        return {
          nodeId,
          approvalInstanceId: approvalInstanceIdFromNode(node),
          approvers: rawUsers.map(user => user.name ?? user.email ?? '').filter(Boolean),
          userGroups: rawGroups.map(formatUserGroupLabel),
          minimumCount: spec.approvers?.minimumCount ?? 1,
          canApprove: canApprove ?? true,
          stageIdentifier: stageIdFromBaseFqn(node.baseFqn),
        };
      }));

      logger.debug('Harness', 'Sending APPROVAL_UPDATE to webview:', {
        planExecutionId,
        nodes: approvals.map(approval => approval.nodeId),
      });
      webview.send({ type: 'APPROVAL_UPDATE', planExecutionId, approvals });

      const external = [
        ...waiting(node => node.stepType === 'JiraApproval' && isWaiting(node)).map(({ nodeId, node }) => {
          const spec = (node.stepParameters?.spec ?? {}) as Record<string, any>;
          const issueKey = spec.issueKey ?? '';
          return {
            nodeId,
            approvalType: 'Jira' as const,
            ticketId: issueKey,
            ticketUrl: issueKey ? `https://harness.atlassian.net/browse/${issueKey}` : undefined,
            projectKey: spec.projectKey ?? '',
            issueType: spec.issueType ?? '',
            approvalCriteria: criteriaText(spec.approvalCriteria),
            rejectionCriteria: criteriaText(spec.rejectionCriteria),
            stageIdentifier: stageIdFromBaseFqn(node.baseFqn),
          };
        }),
        ...waiting(node => node.stepType === 'ServiceNowApproval' && isWaiting(node)).map(({ nodeId, node }) => {
          const spec = (node.stepParameters?.spec ?? {}) as Record<string, any>;
          const ticketNumber = spec.ticketNumber ?? spec.issueNumber ?? '';
          const ticketType = spec.ticketType ?? '';
          return {
            nodeId,
            approvalType: 'ServiceNow' as const,
            ticketId: ticketNumber,
            ticketUrl: ticketNumber ? `https://instance.service-now.com/nav_to.do?uri=${ticketType}/${ticketNumber}` : undefined,
            ticketType,
            approvalCriteria: criteriaText(spec.approvalCriteria),
            rejectionCriteria: criteriaText(spec.rejectionCriteria),
            stageIdentifier: stageIdFromBaseFqn(node.baseFqn),
          };
        }),
      ];
      webview.send({ type: 'EXTERNAL_APPROVAL_UPDATE', planExecutionId, approvals: external });
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
