import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approvalActivityUrl,
  approvalInstanceIdFromNode,
  approvalInstancesUrl,
  parseApprovalInstances,
  selectApprovalInstanceId,
  type ApproverInputField,
} from './approvalInstances';
import { formatUserGroupLabel, resolveUserGroup, userGroupMemberUrl } from './userGroups';
import { approvalBack, submitApproval } from './approvalService';
import type { HarnessConfig } from '../config/configManager';

describe('user group scope', () => {
  it('keeps the built-in project group identifier intact', () => {
    assert.deepEqual(resolveUserGroup('_project_all_users'), {
      groupId: '_project_all_users',
      scope: 'project',
    });
    const url = userGroupMemberUrl(
      'https://app.harness.io',
      'acct',
      'org',
      'proj',
      '_project_all_users',
      'user-1',
    );
    assert.match(url, /\/user-groups\/_project_all_users\/member\/user-1/);
    assert.match(url, /projectIdentifier=proj/);
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
      'org',
      'proj',
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
      approvalInstancesUrl('https://app.harness.io/', 'org', 'proj', 'exec/1', 'node 1'),
      'https://app.harness.io/gateway/pipeline/api/v1/orgs/org/projects/proj/approvals/execution/exec%2F1?approval_status=WAITING&approval_type=HarnessApproval&node_execution_id=node+1',
    );
    assert.equal(
      approvalActivityUrl('https://app.harness.io', 'inst-1', 'acct'),
      'https://app.harness.io/gateway/pipeline/api/approvals/inst-1/harness/activity?accountIdentifier=acct',
    );
  });
});

const config: HarnessConfig = {
  baseUrl: 'https://example.harness.io',
  accountIdentifier: 'example-account',
  orgIdentifier: 'example-org',
  projectIdentifier: 'example-project',
  pollingIntervalSeconds: 30,
  diffAwareSTO: false,
  apiKey: 'test-only',
};

// Synthetic version of the raw v1 endpoint shape (the MCP tool wraps the array).
const fields = [
  { name: 'release_note', defaultValue: '', required: true, allowedValues: [], selectOneFrom: [], regex: null, description: null },
  { name: 'release_color', defaultValue: '', required: false, allowedValues: ['blue', 'green'], selectOneFrom: [], regex: null, description: null },
  { name: 'release_mode', defaultValue: 'beta', required: false, allowedValues: [], selectOneFrom: ['alpha', 'beta'], regex: null, description: 'Choose a mode' },
];
const instance = (approverInputs: unknown) => ({ id: 'inst-1', type: 'HarnessApproval', status: 'WAITING', details: { approverInputs } });
const neverPrompt = async (): Promise<never> => assert.fail('Expected no approval input prompts or review');
const noPrompts = { promptForInput: neverPrompt, reviewInputs: neverPrompt };

function mockApprovalApi(t: import('node:test').TestContext, lookup: Response, activityStatus = 204) {
  const requests: Array<{ url: URL; method: string; body?: unknown }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ url: new URL(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') return lookup;
    return activityStatus === 204
      ? new Response(null, { status: activityStatus })
      : new Response('server echoed a submitted value', { status: activityStatus });
  });
  return requests;
}

const target = { nodeExecutionId: 'node-1', approvalInstanceId: 'inst-1' };

describe('native approval activity', () => {
  it('verifies an existing instance, prompts for every field, and submits exact name/value pairs together', async t => {
    const requests = mockApprovalApi(t, Response.json([instance(fields)]));
    const prompted: Array<{ field: ApproverInputField; step: number; total: number }> = [];
    const submitted = await submitApproval(config, 'exec-1', 'APPROVE', {
      ...target,
      comments: 'Reviewed',
      promptForInput: async (field, step, total) => {
        assert.equal(requests.length, 1, 'no submission before all prompts finish');
        prompted.push({ field, step, total });
        return ['  reviewed verbatim  ', '', 'beta'][step - 1];
      },
      reviewInputs: async values => {
        assert.equal(requests.length, 1, 'no submission before review is confirmed');
        assert.deepEqual(values.map(({ value }) => value), ['  reviewed verbatim  ', '', 'beta']);
        return 'approve';
      },
    });
    assert.equal(submitted, true);
    assert.deepEqual(prompted, [
      { field: { name: 'release_note', defaultValue: '', required: true, choices: [], description: undefined }, step: 1, total: 3 },
      { field: { name: 'release_color', defaultValue: '', required: false, choices: ['blue', 'green'], description: undefined }, step: 2, total: 3 },
      { field: { name: 'release_mode', defaultValue: 'beta', required: false, choices: ['alpha', 'beta'], description: 'Choose a mode' }, step: 3, total: 3 },
    ]);
    assert.deepEqual(requests.map(req => req.method), ['GET', 'POST']);
    assert.match(requests[0].url.pathname, /\/approvals\/execution\/exec-1$/);
    assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), {
      approval_status: 'WAITING', approval_type: 'HarnessApproval', node_execution_id: 'node-1',
    });
    assert.match(requests[1].url.pathname, /\/approvals\/inst-1\/harness\/activity$/);
    assert.deepEqual(requests[1].body, {
      action: 'APPROVE', comments: 'Reviewed', approverInputs: [
        { name: 'release_note', value: '  reviewed verbatim  ' },
        { name: 'release_color', value: '' },
        { name: 'release_mode', value: 'beta' },
      ],
    });
  });

  it('does not submit on cancellation after the first field', async t => {
    const requests = mockApprovalApi(t, Response.json([instance(fields)]));
    const steps: number[] = [];
    assert.equal(await submitApproval(config, 'exec-1', 'APPROVE', {
      ...target,
      promptForInput: async (_field, step) => {
        steps.push(step);
        return step === 1 ? 'not submitted' : undefined;
      },
      reviewInputs: neverPrompt,
    }), false);
    assert.deepEqual(steps, [1, 2]);
    assert.deepEqual(requests.map(req => req.method), ['GET']);
  });

  it('restores answers when going Back and submits only the versions confirmed at review', async t => {
    const requests = mockApprovalApi(t, Response.json([instance(fields)]));
    const visits = [
      { step: 1, previous: undefined, back: false, answer: 'original note' },
      { step: 2, previous: undefined, back: true, answer: 'blue' },
      { step: 3, previous: undefined, back: true, answer: approvalBack },
      { step: 2, previous: 'blue', back: true, answer: 'green' },
      { step: 3, previous: undefined, back: true, answer: 'beta' },
      { step: 3, previous: 'beta', back: true, answer: approvalBack },
      { step: 1, previous: 'original note', back: true, answer: 'edited note' },
    ] as const;
    let visit = 0;
    let review = 0;
    assert.equal(await submitApproval(config, 'exec-1', 'APPROVE', {
      ...target,
      promptForInput: async (_field, step, _total, previous, back) => {
        const { answer, ...expected } = visits[visit++];
        assert.deepEqual({ step, previous, back }, expected);
        return answer;
      },
      reviewInputs: async values => {
        assert.deepEqual(requests.map(req => req.method), ['GET']);
        const action = [approvalBack, 0, 'approve'] as const;
        assert.deepEqual(values.map(({ value }) => value), [review < 2 ? 'original note' : 'edited note', 'green', 'beta']);
        return action[review++];
      },
    }), true);
    assert.equal(visit, visits.length);
    assert.equal(review, 3);
    assert.deepEqual(requests.map(req => req.method), ['GET', 'POST']);
    assert.deepEqual(requests[1].body, {
      action: 'APPROVE', comments: '', approverInputs: [
        { name: 'release_note', value: 'edited note' },
        { name: 'release_color', value: 'green' },
        { name: 'release_mode', value: 'beta' },
      ],
    });
  });

  it('does not submit when review is dismissed even if the only field was filled in', async t => {
    const requests = mockApprovalApi(t, Response.json([instance([fields[0]])]));
    let reviewed = false;
    assert.equal(await submitApproval(config, 'exec-1', 'APPROVE', {
      ...target,
      promptForInput: async () => 'not submitted',
      reviewInputs: async values => {
        assert.deepEqual(values, [{ name: 'release_note', value: 'not submitted' }]);
        reviewed = true;
        return undefined;
      },
    }), false);
    assert.equal(reviewed, true);
    assert.deepEqual(requests.map(req => req.method), ['GET']);
  });

  it('approves a verified input-free step without prompts even when the graph has no instance ID', async t => {
    const requests = mockApprovalApi(t, Response.json([instance([])]));
    assert.equal(await submitApproval(config, 'exec-1', 'APPROVE', {
      nodeExecutionId: target.nodeExecutionId, ...noPrompts,
    }), true);
    assert.deepEqual(requests.map(req => req.method), ['GET', 'POST']);
    assert.match(requests[1].url.pathname, /\/approvals\/inst-1\/harness\/activity$/);
    assert.deepEqual(requests[1].body, { action: 'APPROVE', comments: '', approverInputs: [] });
  });

  it('rejects a known instance without a metadata lookup or prompts', async t => {
    const requests = mockApprovalApi(t, new Response(null, { status: 403 }));
    assert.equal(await submitApproval(config, 'exec-1', 'REJECT', { ...target, comments: 'Not ready', ...noPrompts }), true);
    assert.deepEqual(requests.map(req => req.method), ['POST']);
    assert.match(requests[0].url.pathname, /\/approvals\/inst-1\/harness\/activity$/);
    assert.deepEqual(requests[0].body, { action: 'REJECT', comments: 'Not ready', approverInputs: [] });
  });

  it('still resolves rejection by node without approver input metadata', async t => {
    const requests = mockApprovalApi(t, Response.json({ data: { content: [{ id: 'inst-1' }] } }));
    assert.equal(await submitApproval(config, 'exec-1', 'REJECT', {
      nodeExecutionId: target.nodeExecutionId, ...noPrompts,
    }), true);
    assert.deepEqual(requests.map(req => req.method), ['GET', 'POST']);
    assert.match(requests[1].url.pathname, /\/approvals\/inst-1\/harness\/activity$/);
    assert.deepEqual(requests[1].body, { action: 'REJECT', comments: '', approverInputs: [] });
  });

  const invalidLookups: Array<[string, () => Response]> = [
    ['no matching instance', () => Response.json([])],
    ['more than one instance', () => Response.json([instance([]), { ...instance([]), id: 'inst-2' }])],
    ['a different instance ID', () => Response.json([{ ...instance([]), id: 'inst-2' }])],
    ['a different node ID', () => Response.json([{ ...instance([]), node_execution_id: 'node-2' }])],
    ['a finished approval', () => Response.json([{ ...instance([]), status: 'APPROVED' }])],
    ['another approval type', () => Response.json([{ ...instance([]), type: 'JiraApproval' }])],
    ['missing input metadata', () => Response.json([instance(undefined)])],
    ['unrecognized input metadata', () => Response.json([instance({ fields: [] })])],
    ['a malformed field after a valid field', () => Response.json([instance([fields[0], { ...fields[1], allowedValues: 'blue,green' }])])],
    ['duplicate field names', () => Response.json([instance([fields[0], fields[0]])])],
    ['an unverified constraint', () => Response.json([instance([{ ...fields[0], regex: '.*abc' }])])],
    ['an unexpected response envelope', () => Response.json({ items: [instance([])] })],
    ['an HTTP failure', () => new Response(null, { status: 403 })],
    ['invalid JSON', () => new Response('not-json')],
  ];
  for (const [reason, lookup] of invalidLookups) {
    it(`never prompts or submits when the lookup has ${reason}`, async t => {
      const requests = mockApprovalApi(t, lookup());
      await assert.rejects(submitApproval(config, 'exec-1', 'APPROVE', { ...target, ...noPrompts }), /Harness web UI to approve it/);
      assert.deepEqual(requests.map(req => req.method), ['GET']);
    });
  }

  it('does not include submitted values in a server error', async t => {
    const requests = mockApprovalApi(t, Response.json([instance([fields[0]])]), 400);
    await assert.rejects(submitApproval(config, 'exec-1', 'APPROVE', {
      ...target,
      promptForInput: async () => 'server echoed a submitted value',
      reviewInputs: async () => 'approve',
    }), { message: 'HTTP 400. Check the execution in the Harness web UI.' });
    assert.deepEqual(requests.map(req => req.method), ['GET', 'POST']);
  });
});
