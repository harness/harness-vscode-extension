import { HarnessConfig } from '../config/configManager';
import { logger } from '../utils/logger';

export interface HarnessCurrentUser {
  uuid: string;
  email: string;
  name: string;
}

/**
 * Fetches the currently authenticated user's profile.
 * GET /ng/api/users/currentUser?accountIdentifier=...
 */
export async function getCurrentUser(config: HarnessConfig): Promise<HarnessCurrentUser | null> {
  try {
    const qs = new URLSearchParams({ accountIdentifier: config.accountIdentifier });
    const url = `${config.baseUrl}/ng/api/user/currentUser?${qs}`;
    logger.debug('UserService', 'getCurrentUser →', url);

    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': config.apiKey, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      logger.debug('UserService', 'getCurrentUser HTTP', res.status);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('UserService', 'getCurrentUser failed:', text.slice(0, 200));
        return null;
      }
      const json = await res.json();
      logger.debug('UserService', 'getCurrentUser payload:', JSON.stringify(json?.data));
      const u = json?.data;
      if (!u?.uuid) {
        logger.warn('UserService', 'getCurrentUser: no uuid in response');
        return null;
      }
      return { uuid: u.uuid, email: u.email ?? '', name: u.name ?? '' };
    } catch (e) {
      clearTimeout(timeoutId);
      logger.error('UserService', 'getCurrentUser exception:', e);
      return null;
    }
  } catch (e) {
    logger.error('UserService', 'getCurrentUser exception:', e);
    return null;
  }
}

/**
 * Checks if a user is a member of a specific group.
 * GET /ng/api/user-groups/{groupId}/member/{userIdentifier}
 *
 * Harness group identifiers are prefixed with their scope:
 *   account.<id>  → account-scoped  (no org/project in query)
 *   org.<id>      → org-scoped      (account + org)
 *   _project_<id> → project-scoped  (account + org + project)
 *   <id>          → project-scoped  (default)
 */
async function isUserInGroup(
  config: HarnessConfig,
  rawGroupId: string,
  userUuid: string
): Promise<boolean> {
  try {
    let groupId = rawGroupId;
    const qs: Record<string, string> = { accountIdentifier: config.accountIdentifier };

    if (rawGroupId.startsWith('account.')) {
      groupId = rawGroupId.slice('account.'.length);
      // account-scoped: no org/project params
    } else if (rawGroupId.startsWith('org.')) {
      groupId = rawGroupId.slice('org.'.length);
      qs.orgIdentifier = config.orgIdentifier;
    } else {
      // project-scoped (with or without _project_ prefix)
      groupId = rawGroupId.replace(/^_project_/, '');
      qs.orgIdentifier     = config.orgIdentifier;
      qs.projectIdentifier = config.projectIdentifier;
    }

    const url = `${config.baseUrl}/ng/api/user-groups/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userUuid)}?${new URLSearchParams(qs)}`;
    logger.debug('UserService', 'isUserInGroup →', url);

    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': config.apiKey, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      logger.debug('UserService', 'isUserInGroup HTTP', res.status, 'for group', rawGroupId);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('UserService', 'isUserInGroup failed:', text.slice(0, 200));
        return false;
      }
      const json = await res.json();
      logger.debug('UserService', 'isUserInGroup payload:', JSON.stringify(json?.data));
      // Response data is a boolean: true if member
      return json?.data === true;
    } catch (e) {
      clearTimeout(timeoutId);
      logger.error('UserService', 'isUserInGroup exception:', e);
      return false;
    }
  } catch (e) {
    logger.error('UserService', 'isUserInGroup exception:', e);
    return false;
  }
}

/**
 * Determines whether the current user is allowed to approve a pipeline step,
 * based on the step's approver configuration.
 *
 * @param approverUsers  Raw user objects from stepParameters.spec.approvers.users
 * @param approverGroups Group identifiers from stepParameters.spec.approvers.userGroups
 * @returns true  → show Approve/Reject buttons
 *          false → hide buttons (user is not an approver)
 *          null  → could not determine (API error) — caller should default to showing buttons
 */
export async function canCurrentUserApprove(
  config: HarnessConfig,
  approverUsers: Array<{ uuid?: string; email?: string }>,
  approverGroups: string[]
): Promise<boolean | null> {
  logger.debug('UserService', 'canCurrentUserApprove — approverUsers:', JSON.stringify(approverUsers), '| approverGroups:', JSON.stringify(approverGroups));

  // No restrictions configured → anyone can approve
  if (!approverUsers.length && !approverGroups.length) {
    logger.debug('UserService', 'canCurrentUserApprove → no restrictions, allowing');
    return true;
  }

  const user = await getCurrentUser(config);
  if (!user) {
    logger.warn('UserService', 'canCurrentUserApprove → could not fetch current user, defaulting to null');
    return null;
  }
  logger.debug('UserService', 'canCurrentUserApprove — current user:', JSON.stringify(user));

  // Direct user match (uuid or email)
  const directMatch = approverUsers.some(
    u => (u.uuid && u.uuid === user.uuid) ||
         (u.email && u.email.toLowerCase() === user.email.toLowerCase())
  );
  if (directMatch) {
    logger.debug('UserService', 'canCurrentUserApprove → direct user match');
    return true;
  }

  // No groups to check
  if (!approverGroups.length) {
    logger.debug('UserService', 'canCurrentUserApprove → no group match and no groups to check → false');
    return false;
  }

  // Check each group individually — runs in parallel, short-circuits on first match
  logger.debug('UserService', 'canCurrentUserApprove — checking groups:', approverGroups);
  const results = await Promise.all(approverGroups.map(g => isUserInGroup(config, g, user.uuid)));
  const result = results.some(Boolean);
  logger.debug('UserService', 'canCurrentUserApprove → group check result:', result);
  return result;
}
