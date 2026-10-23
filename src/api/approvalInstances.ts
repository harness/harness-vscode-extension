export interface ApprovalInstanceRef {
  id: string;
  nodeExecutionId?: string;
}

export function approvalInstanceIdFromNode(node: {
  outcomes?: Record<string, { approvalInstanceId?: string } | null | undefined>;
}): string | undefined {
  const outcomes = node.outcomes;
  if (!outcomes) return undefined;
  for (const value of Object.values(outcomes)) {
    const id = value?.approvalInstanceId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function instanceList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  const data = root?.data ?? root?.content;
  if (Array.isArray(data)) return data;
  const nested = asRecord(data);
  if (Array.isArray(nested?.content)) return nested.content;
  if (Array.isArray(nested?.data)) return nested.data;
  return [];
}

function nodeExecutionIdOf(item: Record<string, unknown>): string | undefined {
  const direct = item.nodeExecutionId ?? item.node_execution_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const details = asRecord(item.details);
  const nested = details?.nodeExecutionId ?? details?.node_execution_id;
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined;
}

export function parseApprovalInstances(payload: unknown): ApprovalInstanceRef[] {
  return instanceList(payload).flatMap(item => {
    const record = asRecord(item);
    const id = record?.id;
    if (typeof id !== 'string' || id.length === 0) return [];
    return [{ id, nodeExecutionId: record ? nodeExecutionIdOf(record) : undefined }];
  });
}

/**
 * Pick the instance for the clicked step. A list that still contains more
 * than one waiting instance is ambiguous, so it is refused rather than
 * approved against the execution as a whole.
 */
export function selectApprovalInstanceId(
  instances: ApprovalInstanceRef[],
  nodeExecutionId?: string,
): string | undefined {
  if (nodeExecutionId) {
    const exact = instances.filter(instance => instance.nodeExecutionId === nodeExecutionId);
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) return undefined;
    if (instances.length === 1 && !instances[0].nodeExecutionId) return instances[0].id;
    return undefined;
  }
  return instances.length === 1 ? instances[0].id : undefined;
}

export function approvalInstancesUrl(
  baseUrl: string,
  orgIdentifier: string,
  projectIdentifier: string,
  planExecutionId: string,
  nodeExecutionId: string,
): string {
  const qs = new URLSearchParams({
    approval_status: 'WAITING',
    approval_type: 'HarnessApproval',
    node_execution_id: nodeExecutionId,
  });
  const root = baseUrl.replace(/\/$/, '');
  return `${root}/gateway/pipeline/api/v1/orgs/${encodeURIComponent(orgIdentifier)}/projects/${encodeURIComponent(projectIdentifier)}/approvals/execution/${encodeURIComponent(planExecutionId)}?${qs}`;
}

export function approvalActivityUrl(
  baseUrl: string,
  approvalInstanceId: string,
  accountIdentifier: string,
): string {
  const qs = new URLSearchParams({ accountIdentifier });
  const root = baseUrl.replace(/\/$/, '');
  return `${root}/gateway/pipeline/api/approvals/${encodeURIComponent(approvalInstanceId)}/harness/activity?${qs}`;
}
