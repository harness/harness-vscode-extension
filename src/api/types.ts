// Harness API shared types

export interface ExecutionSummary {
  planExecutionId: string;
  pipelineIdentifier: string;
  name: string;
  status: string;
  /** "1" is a Harness 3.0 pipeline. "0" or absent is the legacy format. */
  yamlVersion?: string;
  startTs: number;
  endTs?: number;
  moduleInfo?: ModuleInfo;
  layoutNodeMap?: Record<string, LayoutNode>;
  // Trigger info — present on webhook-triggered runs
  executionTriggerInfo?: {
    triggerType?: string; // WEBHOOK, MANUAL, SCHEDULER_CRON, etc.
    triggeredBy?: {
      triggerIdentifier?: string;
    };
    ngTriggerInfo?: {
      type?: string;
    };
  };
}

export interface ExecutionDetail {
  planExecutionId: string;
  pipelineIdentifier: string;
  name: string;
  status: string;
  /** "1" is a Harness 3.0 pipeline. "0" or absent is the legacy format. */
  yamlVersion?: string;
  startTs: number;
  endTs?: number;
  runSequence?: number;
  moduleInfo: ModuleInfo;
  layoutNodeMap: Record<string, LayoutNode>;
  pipelineUrl?: string;
  governanceMetadata?: GovernanceMetadata;
}

export interface ModuleInfo {
  ci?: CiModuleInfo;
  cd?: Record<string, unknown>;
  sto?: Record<string, unknown>;
  ti?: Record<string, unknown>;
  ssca?: Record<string, unknown>;
  ccm?: Record<string, unknown>;
}

export interface CiModuleInfo {
  ciExecutionInfoDTO?: {
    branch?: {
      commits?: Array<{ id: string; message?: string }>;
    };
    pullRequest?: {
      commits?: Array<{ id: string }>;
    };
  };
  repoName?: string;
  branch?: string;
  repoUrl?: string;  // Full git repo URL
  gitConnectionType?: string;  // 'ACCOUNT', 'REPO', etc.
}

export interface LayoutNode {
  nodeUuid: string;
  nodeType: string;
  /** YAML identifier. v1 uses this to match a layout stage to its graph node. */
  nodeIdentifier?: string;
  name: string;
  status: string;
  startTs?: number | null;
  endTs?: number | null;
  nodeGroup?: string;
  edgeLayoutList?: { currentNodeChildren?: string[]; nextIds?: string[] };
  logBaseKey?: string;
  stepType?: string;
  failureInfo?: { message?: string };
  // Approval stage — present when status is APPROVAL_WAITING
  executableElementsCount?: number;
  shouldRunOnAnyAllExecutions?: boolean;
}

// executionGraph — returned alongside pipelineExecutionSummary in /v2 response.
// Legacy responses keep step nodes here and stages in layoutNodeMap. v1 responses
// also copy steps into layoutNodeMap, all tagged nodeGroup "STAGE".
export interface ExecutionGraph {
  rootNodeId?: string;
  nodeMap?: Record<string, ExecutionNode>;
  nodeAdjacencyListMap?: Record<string, { children?: string[]; nextIds?: string[] }>;
}

export interface ExecutionNode {
  uuid?: string;
  name: string;
  identifier?: string;   // YAML step/stage ID — used in log prefix construction
  baseFqn?: string;      // fully-qualified node name — sometimes used as log key
  status: string;
  stepType?: string;
  startTs?: number | null;
  endTs?: number | null;
  failureInfo?: { message?: string };
  logBaseKey?: string;
  executableResponses?: ExecutableResponse[];
  unitProgresses?: Array<{ unitName: string; status: string; startTime?: number; endTime?: number }>;
  // HarnessApproval step — present when waiting for approval
  executableElementsCount?: number;
  // `outcomes` holds approval instances, step artifacts, AND (for STO scanner
  // steps) the aggregate vulnerability counts. The counts live under the
  // `output` key: outcomes.output.outputVariables.
  outcomes?: Record<string, {
    approvalInstanceId?: string;
    outputVariables?: Record<string, string>;
    stepArtifacts?: unknown;
  }>;
  // Present on the legacy custom `Security` scan node — product_name reveals
  // the underlying scanner.
  stepParameters?: { spec?: Record<string, unknown> & { product_name?: string } };
}

export interface ExecutableResponse {
  task?: { logKeys?: string[]; units?: string[] };
  taskChain?: { logKeys?: string[]; units?: string[] };
  async?: { logKeys?: string[]; units?: string[] };
  asyncChain?: { logKeys?: string[]; units?: string[] };
  sync?: { logKeys?: string[]; units?: string[] };
  child?: { logKeys?: string[]; units?: string[] };
  children?: { logKeys?: string[]; units?: string[] };
}

export interface StoFinding {
  id: string;
  type: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' | 'CRITICAL';
  title: string;
  description?: string;
  cveId?: string;
  referenceUrl?: string;
  location?: {
    file?: string;
    line?: number;
  };
}

export interface TiTestResult {
  testCaseName: string;
  testSuiteName: string;
  status: 'FAILED' | 'PASSED' | 'SKIPPED' | 'ERROR';
  durationMs?: number;
  errorMessage?: string;
  stackTrace?: string;
  file?: string;
  lineNumber?: number;
}

export interface TiOverview {
  total: number;
  failed: number;
  passed: number;
  skipped: number;
  selected?: number;
  tests?: TiTestResult[];
}

export interface TiFlakyTest {
  testCaseName: string;
  testSuiteName: string;
  failureRate: number;
  totalRuns: number;
}

export interface SscaComponent {
  name: string;
  version: string;
  license?: string;
  isFlagged: boolean;
  riskReason?: string;
}

export interface SscaSbom {
  flaggedComponents?: SscaComponent[];
  components?: SscaComponent[];
}

export interface AidaRca {
  cause?: string;
  summary?: string;
  resolution?: string;
  confidence?: number;
  deepDiveUrl?: string;
}

export interface PolicyEvaluation {
  policySetName?: string;
  status: string;
  details?: Array<{
    policyName: string;
    denyMessages?: string[];
    status: string;
  }>;
  policyUrl?: string;
}

// governanceMetadata is embedded in the execution detail response
export interface GovernanceMetadata {
  status?: string;  // "pass" | "warning" | "error"
  deny?: boolean;
  details?: Array<{
    policySetId?: string;
    policySetName?: string;
    status?: string;
    policyMetadata?: Array<{
      policyId?: string;
      policyName?: string;
      severity?: string;
      status?: string;   // "pass" | "warning" | "error"
      denyMessages?: string[];
    }>;
  }>;
}

export interface DeploymentStatus {
  environment: string;
  status: string;
  serviceId?: string;
  serviceName?: string;
  artifactTag?: string;
  lastDeployedAt?: number;
}

export interface BuildCost {
  totalCost?: number;
  currency?: string;
  branchAvgCost?: number;
}

export interface FlagState {
  key: string;
  name: string;
  enabled: boolean;
  environments: Array<{
    identifier: string;
    name: string;
    enabled: boolean;
  }>;
}
