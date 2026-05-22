export type MCPScope = 'project' | 'global';

export interface MCPScopeInfo {
  scope: MCPScope;
  path: string;          // absolute path to the file
  configured: boolean;   // mcpServers.harness exists and is valid in this file
}

export interface MCPDetectionState {
  project: MCPScopeInfo | null;  // null when no workspace folder is open
  global: MCPScopeInfo;
  activeScope: MCPScope | null;   // 'project' if configured there, else 'global' if configured there, else null
  conflict: boolean;              // true when both project AND global have harness configured
}
