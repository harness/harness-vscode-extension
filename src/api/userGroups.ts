export type UserGroupScope = 'account' | 'org' | 'project';

export interface ResolvedUserGroup {
  groupId: string;
  scope: UserGroupScope;
}

const BUILTIN_LABELS: Record<string, string> = {
  _project_all_users: 'All Project Users',
  _organization_all_users: 'All Organization Users',
  _account_all_users: 'All Account Users',
};

/**
 * Harness stores built-in group identifiers literally (`_project_all_users`).
 * Only `account.` and `org.` are scope prefixes. `_project_` is part of the id.
 */
export function resolveUserGroup(rawGroupId: string): ResolvedUserGroup {
  if (rawGroupId.startsWith('account.')) {
    return { groupId: rawGroupId.slice('account.'.length), scope: 'account' };
  }
  if (rawGroupId.startsWith('org.')) {
    return { groupId: rawGroupId.slice('org.'.length), scope: 'org' };
  }
  return { groupId: rawGroupId, scope: 'project' };
}

export function formatUserGroupLabel(rawGroupId: string): string {
  const { groupId } = resolveUserGroup(rawGroupId);
  return BUILTIN_LABELS[groupId] ?? groupId;
}

export function userGroupMemberUrl(
  baseUrl: string,
  accountIdentifier: string,
  orgIdentifier: string,
  projectIdentifier: string,
  rawGroupId: string,
  userUuid: string,
): string {
  const { groupId, scope } = resolveUserGroup(rawGroupId);
  const qs = new URLSearchParams({ accountIdentifier });
  if (scope === 'org' || scope === 'project') qs.set('orgIdentifier', orgIdentifier);
  if (scope === 'project') qs.set('projectIdentifier', projectIdentifier);
  const root = baseUrl.replace(/\/$/, '');
  return `${root}/ng/api/user-groups/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userUuid)}?${qs}`;
}
