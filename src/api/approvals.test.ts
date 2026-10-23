import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approvalActivityUrl,
  approvalInstanceIdFromNode,
  approvalInstancesUrl,
  parseApprovalInstances,
  selectApprovalInstanceId,
} from './approvalInstances';
import { formatUserGroupLabel, resolveUserGroup, userGroupMemberUrl } from './userGroups';

describe('user group scope', () => {
  it('keeps the built-in project group identifier intact', () => {
    assert.deepEqual(resolveUserGroup('_project_all_users'), {
      groupId: '_project_all_users',
      scope: 'project',
    });
    const url = userGroupMemberUrl(
      'https://app.harness.io',
      'acct',
      'sandbox',
      'luisredda',
      '_project_all_users',
      'user-1',
    );
    assert.match(url, /\/user-groups\/_project_all_users\/member\/user-1/);
    assert.match(url, /projectIdentifier=luisredda/);
    assert.equal(formatUserGroupLabel('_project_all_users'), 'All Project Users');
  });

  it('strips only account and org scope prefixes', () => {
    assert.deepEqual(resolveUserGroup('account._account_all_users'), {
      groupId: '_account_all_users',
      scope: 'account',
    });
    assert.deepEqual(resolveUserGroup('org._organization_all_users'), {
      groupId: '_organization_all_users',
      scope: 'org',
    });
    const accountUrl = userGroupMemberUrl(
      'https://app.harness.io/',
      'acct',
      'sandbox',
      'luisredda',
      'account.AccountAdmin',
      'user-1',
    );
    assert.match(accountUrl, /\/user-groups\/AccountAdmin\/member\/user-1/);
    assert.doesNotMatch(accountUrl, /orgIdentifier|projectIdentifier/);
    assert.equal(formatUserGroupLabel('account._account_all_users'), 'All Account Users');
    assert.equal(formatUserGroupLabel('org._organization_all_users'), 'All Organization Users');
    assert.equal(formatUserGroupLabel('account.AccountAdmin'), 'AccountAdmin');
  });
});

describe('approval instance selection', () => {
  it('reads an instance id embedded on the graph node', () => {
    assert.equal(approvalInstanceIdFromNode({
      outcomes: { approval: { approvalInstanceId: 'inst-1' } },
    }), 'inst-1');
    assert.equal(approvalInstanceIdFromNode({ outcomes: {} }), undefined);
  });

  it('parses wrapped instance lists and refuses an ambiguous list', () => {
    const instances = parseApprovalInstances({
      data: {
        content: [
          { id: 'a', node_execution_id: 'node-a' },
          { id: 'b', nodeExecutionId: 'node-b' },
        ],
      },
    });
    assert.equal(selectApprovalInstanceId(instances, 'node-b'), 'b');
    assert.equal(selectApprovalInstanceId(instances), undefined);
    assert.equal(selectApprovalInstanceId([{ id: 'only' }], 'node-a'), 'only');
  });

  it('builds the instance lookup and activity urls', () => {
    assert.equal(
      approvalInstancesUrl('https://app.harness.io/', 'sandbox', 'luisredda', 'exec/1', 'node 1'),
      'https://app.harness.io/gateway/pipeline/api/v1/orgs/sandbox/projects/luisredda/approvals/execution/exec%2F1?approval_status=WAITING&approval_type=HarnessApproval&node_execution_id=node+1',
    );
    assert.equal(
      approvalActivityUrl('https://app.harness.io', 'inst-1', 'acct'),
      'https://app.harness.io/gateway/pipeline/api/approvals/inst-1/harness/activity?accountIdentifier=acct',
    );
  });
});
