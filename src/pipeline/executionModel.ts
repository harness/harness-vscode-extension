// Per-execution view of a Harness pipeline graph.
// Legacy (yamlVersion "0") and Harness 3.0 (yamlVersion "1") executions can
// share an account, so every helper below decides from the execution itself.

export type ExecutionYamlVersion = '0' | '1';

export interface LayoutLike {
  nodeUuid: string;
  name: string;
  status: string;
  nodeGroup?: string;
  nodeType?: string;
  nodeIdentifier?: string;
  stepType?: string;
  startTs?: number | null;
  endTs?: number | null;
  edgeLayoutList?: { currentNodeChildren?: string[]; nextIds?: string[] };
  logBaseKey?: string;
  failureInfo?: { message?: string };
}

export interface LogResponseLike {
  logKeys?: string[];
  units?: string[];
}

export interface ExecutableResponseLike {
  task?: LogResponseLike;
  taskChain?: LogResponseLike;
  async?: LogResponseLike;
  asyncChain?: LogResponseLike;
  sync?: LogResponseLike;
  child?: LogResponseLike;
  children?: LogResponseLike;
}

export interface LogUnit {
  key: string;
  unit: string;
}

export interface GraphNodeLike {
  uuid?: string;
  name?: string;
  identifier?: string;
  baseFqn?: string;
  status?: string;
  stepType?: string;
  startTs?: number | null;
  endTs?: number | null;
  logBaseKey?: string;
  failureInfo?: { message?: string };
  executableResponses?: ExecutableResponseLike[];
}

export interface GraphLike {
  rootNodeId?: string;
  nodeMap?: Record<string, GraphNodeLike>;
  nodeAdjacencyListMap?: Record<string, { children?: string[]; nextIds?: string[] }>;
}

export interface StepView {
  name: string;
  status: string;
  startTs?: number;
  endTs?: number;
  nodeId?: string;
  logBaseKey?: string;
  /** Every log section for this step, in graph order. */
  logUnits?: LogUnit[];
  stepType?: string;
  identifier?: string;
  parentGroupName?: string;
  /** Indent level under the stage. Children of a visible group are one level deeper. */
  depth: number;
  /** Step group row. Its children follow at depth + 1. */
  isGroup?: boolean;
}

// Graph step types that open a new stage. Traversal stops so one stage's
// nextIds cannot leak into the following stage.
const STAGE_TYPES = new Set([
  'IntegrationStageStepPMS',
  'PIPELINE_STAGE',
  'PIPELINE_ROLLBACK',
  'STAGE_ROLLBACK',
  'DeploymentStageStepPMS',
  'ApprovalStageStepPMS',
  'APPROVAL_STAGE',
  'CustomStageStepPMS',
  'IDPStage',
  'CUSTOM_STAGE',
]);

// Plumbing nodes. Walk through them; do not render them as steps.
const CONTAINER_TYPES = new Set([
  'NG_SECTION', 'NG_SECTION_WITH_ROLLBACK_INFO', 'FORK', 'NG_FORK', 'ROLLBACK_OPTIONAL_CHILD_CHAIN',
  'PIPELINE', 'PIPELINE_SECTION',
  'BARRIER', 'QUEUE', 'STRATEGY',
  'INFRASTRUCTURE_SECTION', 'GITOPS_CLUSTERS', 'SPEC',
  'STAGES_STEP',
  'NG_EXECUTION',
  'liteEngineTask',
  'LITEENGINE_TASK',
]);

// Legacy step groups and the v1 GROUP alias. The group stays visible, like the
// Harness CLI tree, and its children are indented one level.
const STEP_GROUP_TYPES = new Set(['STEP_GROUP', 'CI_STEP_GROUP', 'GROUP']);

// v1 layout stages. Steps in that format are also tagged nodeGroup "STAGE",
// so the stage list cannot trust nodeGroup alone.
const V1_STAGE_NODE_TYPES = new Set([
  'unified',
  'PipelineRollback',
  'PIPELINE_ROLLBACK',
  'STAGE_ROLLBACK',
]);

const MAX_NESTING = 32;

export function detectExecutionVersion(
  yamlVersion?: string,
  graph?: GraphLike | null,
  layoutNodeMap?: Record<string, LayoutLike> | null,
): ExecutionYamlVersion {
  if (yamlVersion === '1') return '1';
  if (yamlVersion === '0') return '0';

  const nodes = Object.values(graph?.nodeMap ?? {});
  if (nodes.some(node => node.stepType === 'GROUP')) return '1';
  if (nodes.some(node =>
    !!node.baseFqn && node.baseFqn.includes('.steps.') && !node.baseFqn.includes('.spec.')
  )) return '1';
  if (Object.values(layoutNodeMap ?? {}).some(node => node.nodeType === 'unified')) return '1';
  return '0';
}

/** Stage YAML id from either legacy `.spec.execution.steps` or v1 `.steps` FQNs. */
export function stageIdFromBaseFqn(baseFqn?: string): string | undefined {
  return baseFqn?.match(/^pipeline\.stages\.([^.]+)/)?.[1];
}

export function isStageLevelNode(node: GraphNodeLike): boolean {
  if (node.baseFqn && /^pipeline\.stages\.[^.]+$/.test(node.baseFqn)) return true;
  return !!node.stepType && STAGE_TYPES.has(node.stepType);
}

export function graphStatusHash(graph: GraphLike | null | undefined): string {
  if (!graph?.nodeMap) return 'empty';
  return Object.entries(graph.nodeMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, node]) => `${id}:${node.status ?? ''}`)
    .join('|');
}

/** Ordered log sections from executableResponses[0], then logBaseKey. */
export function resolveLogUnits(node: GraphNodeLike): LogUnit[] {
  const response = node.executableResponses?.[0];
  const source = response?.task
    ?? response?.taskChain
    ?? response?.async
    ?? response?.asyncChain
    ?? response?.sync
    ?? response?.child
    ?? response?.children;
  const keys = source?.logKeys ?? [];
  const labels = source?.units ?? [];
  const units: LogUnit[] = [];
  keys.forEach((key, index) => {
    if (!key) return;
    units.push({ key, unit: labels[index] || `Section ${index + 1}` });
  });
  if (units.length === 0 && node.logBaseKey) {
    units.push({ key: node.logBaseKey, unit: 'Section 1' });
  }
  return units;
}

/** First executable-response log key, then the node's own logBaseKey. */
export function resolveLogKey(node: GraphNodeLike): string | undefined {
  return resolveLogUnits(node)[0]?.key;
}

export function findStageGraphId(stage: LayoutLike, graph: GraphLike): string | undefined {
  const nodeMap = graph.nodeMap ?? {};
  const adjacency = graph.nodeAdjacencyListMap ?? {};
  const entries = Object.entries(nodeMap);

  if (stage.nodeIdentifier) {
    const byIdentifier = entries.find(([, node]) =>
      node.identifier === stage.nodeIdentifier && isStageLevelNode(node)
    );
    if (byIdentifier) return byIdentifier[0];
  }

  if (stage.nodeUuid && (nodeMap[stage.nodeUuid] || adjacency[stage.nodeUuid])) {
    const node = nodeMap[stage.nodeUuid];
    // v1 layout UUIDs are not graph ids. Only accept a UUID hit when it is a
    // stage, or when the node has no FQN (older graphs keyed by layout uuid).
    if (!node || isStageLevelNode(node) || !node.baseFqn) return stage.nodeUuid;
  }

  return entries.find(([, node]) => node.name === stage.name && isStageLevelNode(node))?.[0];
}

export function listLayoutStages<T extends LayoutLike>(
  layoutNodeMap: Record<string, T> | undefined,
  graph?: GraphLike | null,
  yamlVersion?: string,
): T[] {
  const version = detectExecutionVersion(yamlVersion, graph, layoutNodeMap);
  const allEntries = Object.entries(layoutNodeMap ?? {}).filter(([, node]) =>
    version === '1' ? isV1LayoutStage(node, graph) : node.nodeGroup === 'STAGE'
  );
  if (!allEntries.length) return [];

  const shouldExclude = (stage: T): boolean => {
    if (stage.nodeType === 'parallel') return true;
    const isRollback = stage.stepType === 'PIPELINE_ROLLBACK' ||
      stage.stepType === 'STAGE_ROLLBACK' ||
      stage.nodeType === 'PIPELINE_ROLLBACK' ||
      stage.nodeType === 'STAGE_ROLLBACK' ||
      stage.nodeType === 'PipelineRollback' ||
      stage.name?.toLowerCase().includes('rollback');
    if (!isRollback) return false;
    return !stage.startTs || stage.status.toUpperCase() === 'NOT_STARTED' || stage.status.toUpperCase() === 'SKIPPED';
  };

  const byExecutionId = new Map(allEntries);
  const referenced = new Set(allEntries.flatMap(([, stage]) => stage.edgeLayoutList?.nextIds ?? []));
  let roots = allEntries.filter(([execId]) => !referenced.has(execId));
  if (!roots.length) roots = [allEntries[0]];

  const ordered: T[] = [];
  const visited = new Set<string>();
  const queue = roots.map(([execId]) => execId);

  while (queue.length) {
    const execId = queue.shift()!;
    if (visited.has(execId)) continue;
    visited.add(execId);

    const stage = byExecutionId.get(execId);
    if (!stage) continue;
    if (!shouldExclude(stage)) ordered.push(stage);

    for (const nextId of stage.edgeLayoutList?.nextIds ?? []) {
      if (!visited.has(nextId)) queue.push(nextId);
    }
  }

  for (const [execId, stage] of allEntries) {
    if (!visited.has(execId) && !shouldExclude(stage)) ordered.push(stage);
  }

  return ordered.sort((a, b) => {
    const aTime = a.startTs ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.startTs ?? Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  });
}

export function stepsForStage<T extends LayoutLike>(
  stage: T,
  layoutNodeMap: Record<string, T>,
  graph?: GraphLike | null,
  yamlVersion?: string,
): StepView[] {
  const version = detectExecutionVersion(yamlVersion, graph, layoutNodeMap);
  if (graph?.nodeMap && graph.nodeAdjacencyListMap) {
    const stageGraphId = findStageGraphId(stage, graph);
    if (stageGraphId) {
      const visited = new Set<string>([stageGraphId]);
      const seeds = graph.nodeAdjacencyListMap[stageGraphId]?.children ?? [];
      const steps = seeds.flatMap(id =>
        collectSteps(id, graph.nodeMap!, graph.nodeAdjacencyListMap!, 0, visited)
      );
      if (steps.length) return steps;
    }
  }

  const layoutSteps = (stage.edgeLayoutList?.currentNodeChildren ?? [])
    .map(id => layoutNodeMap[id])
    .filter((node): node is T => !!node && node.nodeGroup !== 'STAGE' && !!node.name)
    .map(layoutStep);
  if (layoutSteps.length) return layoutSteps;

  // v1 tags steps as STAGE, so the legacy "everything else" dump would either
  // be empty or mix unrelated stages. Leave an unmatched v1 stage empty.
  if (version === '1') return [];

  return Object.values(layoutNodeMap)
    .filter(node => node.nodeGroup !== 'STAGE' && node.nodeGroup !== undefined && !!node.name)
    .map(layoutStep);
}

function isV1LayoutStage(node: LayoutLike, graph?: GraphLike | null): boolean {
  if (node.nodeGroup !== 'STAGE') return false;
  if (node.nodeType === 'parallel' || node.nodeType === 'group') return false;
  if (node.nodeType && V1_STAGE_NODE_TYPES.has(node.nodeType)) return true;
  if (!node.nodeIdentifier || !graph?.nodeMap) return false;
  return Object.values(graph.nodeMap).some(graphNode =>
    graphNode.identifier === node.nodeIdentifier && isStageLevelNode(graphNode)
  );
}

function collectSteps(
  nodeId: string,
  nodeMap: Record<string, GraphNodeLike>,
  adjList: Record<string, { children?: string[]; nextIds?: string[] }>,
  nesting: number,
  visited: Set<string>,
  parentGroupName?: string,
): StepView[] {
  if (nesting > MAX_NESTING || visited.has(nodeId)) return [];
  visited.add(nodeId);

  const node = nodeMap[nodeId];
  if (!node) return [];
  if (STAGE_TYPES.has(node.stepType ?? '')) return [];

  const adjacency = adjList[nodeId] ?? {};
  const children = adjacency.children ?? [];
  const nextIds = adjacency.nextIds ?? [];
  const stepType = node.stepType ?? '';

  // Siblings stay at this depth. v1 stages chain many steps through nextIds,
  // and that chain is not nesting.
  const followNext = () => nextIds.flatMap(id =>
    collectSteps(id, nodeMap, adjList, nesting, visited, parentGroupName)
  );

  if (STEP_GROUP_TYPES.has(stepType)) {
    const groupName = node.name || parentGroupName;
    const self = node.name ? [toStep(nodeId, node, parentGroupName, nesting, true)] : [];
    const childSteps = children.flatMap(id =>
      collectSteps(id, nodeMap, adjList, nesting + 1, visited, groupName)
    );
    return [...self, ...childSteps, ...followNext()];
  }

  // Hidden plumbing (forks, lite-engine, sections) keeps its children at this
  // depth. The CLI does the same for nodes it does not print.
  if (CONTAINER_TYPES.has(stepType) || !node.name) {
    const fromChildren = children.flatMap(id =>
      collectSteps(id, nodeMap, adjList, nesting, visited, parentGroupName)
    );
    return [...fromChildren, ...followNext()];
  }

  return [toStep(nodeId, node, parentGroupName, nesting), ...followNext()];
}

function toStep(
  nodeId: string,
  node: GraphNodeLike,
  parentGroupName: string | undefined,
  depth: number,
  isGroup = false,
): StepView {
  const logUnits = resolveLogUnits(node);
  return {
    name: node.name ?? '',
    status: node.status ?? '',
    startTs: timestamp(node.startTs),
    endTs: timestamp(node.endTs),
    nodeId,
    logBaseKey: logUnits[0]?.key,
    logUnits,
    stepType: node.stepType,
    identifier: node.identifier,
    parentGroupName,
    depth,
    isGroup,
  };
}

function layoutStep(node: LayoutLike): StepView {
  return {
    name: node.name,
    status: node.status,
    startTs: timestamp(node.startTs),
    endTs: timestamp(node.endTs),
    logBaseKey: node.logBaseKey,
    logUnits: node.logBaseKey ? [{ key: node.logBaseKey, unit: 'Section 1' }] : [],
    stepType: node.stepType,
    identifier: node.nodeIdentifier,
    depth: 0,
  };
}

function timestamp(value?: number | null): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
