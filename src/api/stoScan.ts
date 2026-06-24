import { ExecutionGraph } from './types';

// STO scanner step-type IDs → display names. Source: handoff/sto_steps.md.
// (Trimmed to the common set; extend from the doc's tables as needed.)
const STO_STEP_TYPES: Record<string, string> = {
  // Container
  Anchore: 'Anchore', AquaSecurity: 'Aqua Security', AquaTrivy: 'Aqua Trivy', AWSECR: 'AWS ECR Scan',
  Clair: 'Clair', Grype: 'Grype', JfrogXray: 'Jfrog Xray', PrismaCloud: 'Prisma Cloud', Sysdig: 'Sysdig',
  HarnessSCA: 'Harness Container',
  // SAST
  Bandit: 'Bandit', BlackDuck: 'Black Duck', Brakeman: 'Brakeman', Checkmarx: 'Checkmarx',
  CheckmarxOne: 'CheckmarxOne', CodeQL: 'CodeQL', Coverity: 'Coverity', Fossa: 'Fossa', Mend: 'Mend',
  Semgrep: 'Semgrep', Snyk: 'Snyk', Sonarqube: 'Sonarqube', Veracode: 'Veracode', Wiz: 'Wiz',
  HarnessSAST: 'Harness Code', GitHubAdvancedSecurity: 'GitHub Advanced Security',
  // SCA
  OsvScanner: 'OSV Scanner', Owasp: 'Owasp', NexusIQ: 'NexusIQ',
  // Secrets / DAST / IaC / AWS
  Gitleaks: 'Gitleaks', Burp: 'Burp Suite', Nikto: 'Nikto', Nmap: 'Nmap', Traceable: 'API DAST', Zap: 'Zap',
  Checkov: 'Checkov', AWSSecurityHub: 'AWS Security Hub',
  // Generic
  CustomIngest: 'Custom Ingest', Security: 'Custom Scan',
};

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Sev = typeof SEVERITIES[number];

const n = (v: unknown): number => parseInt(String(v ?? ''), 10) || 0;

export interface SevCount { total: number; new: number; }
export interface StoScanner {
  name: string; stepType: string; total: number; new: number; status: string; consoleUrl?: string;
}
export interface StoScanSummary {
  scanId: string;
  skipped?: boolean;
  running?: boolean;
  tools: string[];
  critical: SevCount; high: SevCount; medium: SevCount; low: SevCount; info: SevCount; exempted: SevCount;
  scanners: StoScanner[];
  stoUrl?: string;
}

/** Returns null when the execution has no STO scanner steps at all. */
export function parseStoScan(
  graph: ExecutionGraph | null | undefined,
  planExecutionId: string,
  stoUrl?: string,
): StoScanSummary | null {
  const nodes = Object.values(graph?.nodeMap ?? {});
  const stoNodes = nodes.filter(node => node.stepType && node.stepType in STO_STEP_TYPES);
  if (stoNodes.length === 0) return null;

  const zero = (): SevCount => ({ total: 0, new: 0 });
  const sum: Record<Sev | 'exempted', SevCount> = {
    critical: zero(), high: zero(), medium: zero(), low: zero(), info: zero(), exempted: zero(),
  };
  const scanners: StoScanner[] = [];
  const tools = new Set<string>();
  let anyOutput = false, anyRunning = false, scanId = '';

  for (const node of stoNodes) {
    const status = String(node.status ?? '').toUpperCase();
    if (status === 'RUNNING' || status === 'ASYNC_WAITING') anyRunning = true;

    // Real path — NOT outcomeDocuments. Read defensively: skipped/running/
    // failed-before-output nodes may have outcomes: {} or none.
    const vars = node.outcomes?.output?.outputVariables;
    const name = STO_STEP_TYPES[node.stepType as string] ?? node.stepType!;

    if (!vars) {
      // Scanner ran/queued but no counts yet (running, skipped, failed-before-output)
      scanners.push({ name, stepType: node.stepType!, total: 0, new: 0, status });
      continue;
    }
    anyOutput = true;
    tools.add(name);
    if (!scanId && vars.JOB_ID) scanId = vars.JOB_ID;

    for (const sev of SEVERITIES) {
      const key = sev.toUpperCase();
      sum[sev].total += n(vars[key]);
      sum[sev].new += n(vars[`NEW_${key}`]);
    }
    // "Exempted" tile ← IGNORED counts (sto_steps.md never documents this mapping)
    sum.exempted.total += n(vars.IGNORED);
    sum.exempted.new += n(vars.NEW_IGNORED);

    const total = SEVERITIES.reduce((t, s) => t + n(vars[s.toUpperCase()]), 0);
    const isNew = SEVERITIES.reduce((t, s) => t + n(vars[`NEW_${s.toUpperCase()}`]), 0);
    scanners.push({
      name, stepType: node.stepType!, total, new: isNew, status,
      consoleUrl: vars.SCANNER_CONSOLE_URL || undefined,
    });
  }

  return {
    scanId: scanId || planExecutionId,
    skipped: !anyOutput && !anyRunning,
    running: anyRunning,
    tools: [...tools],
    ...sum,
    scanners,
    stoUrl,
  };
}
