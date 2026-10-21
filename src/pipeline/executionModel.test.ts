import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectExecutionVersion,
  findStageGraphId,
  graphStatusHash,
  listLayoutStages,
  resolveLogKey,
  resolveLogUnits,
  stageIdFromBaseFqn,
  stepsForStage,
  type GraphLike,
  type LayoutLike,
} from './executionModel';

function layout(partial: Partial<LayoutLike> & Pick<LayoutLike, 'nodeUuid' | 'name' | 'status'>): LayoutLike {
  return { nodeType: 'CI', nodeGroup: 'STAGE', ...partial };
}

describe('execution version', () => {
  it('trusts yamlVersion on the execution', () => {
    assert.equal(detectExecutionVersion('1'), '1');
    assert.equal(detectExecutionVersion('0', {
      nodeMap: { g: { stepType: 'GROUP', baseFqn: 'pipeline.stages.build.steps.cache' } },
    }), '0');
  });

  it('falls back to v1 graph and layout shape when yamlVersion is absent', () => {
    assert.equal(detectExecutionVersion(undefined, {
      nodeMap: { g: { stepType: 'GROUP' } },
    }), '1');
    assert.equal(detectExecutionVersion(undefined, {
      nodeMap: { s: { baseFqn: 'pipeline.stages.build.steps.clone' } },
    }), '1');
    assert.equal(detectExecutionVersion(undefined, null, {
      stage: layout({ nodeUuid: 'stage', name: 'Build', status: 'Success', nodeType: 'unified' }),
    }), '1');
    assert.equal(detectExecutionVersion(undefined, {
      nodeMap: { s: { baseFqn: 'pipeline.stages.build.spec.execution.steps.clone', stepType: 'Run' } },
    }), '0');
  });
});

describe('stage identity', () => {
  it('reads the stage id from both FQN shapes', () => {
    assert.equal(
      stageIdFromBaseFqn('pipeline.stages.Deploy_Dev.spec.execution.steps.promotionApproval'),
      'Deploy_Dev',
    );
    assert.equal(
      stageIdFromBaseFqn('pipeline.stages.build_test_scan_push.steps.supply_chain_security.steps.syft'),
      'build_test_scan_push',
    );
    assert.equal(stageIdFromBaseFqn('pipeline'), undefined);
  });

  it('matches a v1 stage by identifier when the layout uuid differs from the graph uuid', () => {
    const stage = layout({
      nodeUuid: 'layout-build',
      name: 'Build',
      status: 'Failed',
      nodeType: 'unified',
      nodeIdentifier: 'build',
    });
    const graph: GraphLike = {
      nodeMap: {
        'graph-build': {
          name: 'Build',
          identifier: 'build',
          stepType: 'IntegrationStageStepPMS',
          baseFqn: 'pipeline.stages.build',
        },
        'same-name-step': {
          name: 'Build',
          identifier: 'build_step',
          stepType: 'Run',
          baseFqn: 'pipeline.stages.build.steps.build_step',
        },
      },
      nodeAdjacencyListMap: { 'graph-build': { children: [], nextIds: [] } },
    };
    assert.equal(findStageGraphId(stage, graph), 'graph-build');
  });
});

describe('layout stages', () => {
  it('keeps legacy stages and drops parallel wrappers and unstarted rollbacks', () => {
    const map = {
      build: layout({
        nodeUuid: 'build', name: 'Build', status: 'SUCCESS', startTs: 20,
        edgeLayoutList: { nextIds: ['deploy'] },
      }),
      parallel: layout({
        nodeUuid: 'parallel', name: '', status: 'SUCCESS', nodeType: 'parallel', startTs: 10,
      }),
      deploy: layout({
        nodeUuid: 'deploy', name: 'Deploy', status: 'SUCCESS', startTs: 30,
      }),
      rollback: layout({
        nodeUuid: 'rollback', name: 'Pipeline Rollback', status: 'NOT_STARTED', nodeType: 'PipelineRollback',
      }),
    };
    assert.deepEqual(listLayoutStages(map, null, '0').map(stage => stage.name), ['Build', 'Deploy']);
  });

  it('lists only real v1 stages when steps are also tagged STAGE', () => {
    const map = {
      step: layout({
        nodeUuid: 'step', name: 'Clone', status: 'Success', nodeType: 'run', nodeIdentifier: 'clone',
      }),
      group: layout({
        nodeUuid: 'group', name: 'Scans', status: 'Failed', nodeType: 'group', nodeIdentifier: 'scans',
      }),
      qa: layout({
        nodeUuid: 'layout-qa', name: 'Deploy to QA', status: 'Skipped', nodeType: 'unified',
        nodeIdentifier: 'deploy_to_qa',
      }),
      build: layout({
        nodeUuid: 'layout-build', name: 'Build', status: 'Failed', nodeType: 'unified',
        nodeIdentifier: 'build', startTs: 10,
        edgeLayoutList: { nextIds: ['qa'] },
      }),
    };
    const graph: GraphLike = {
      nodeMap: {
        'graph-build': {
          identifier: 'build', name: 'Build', stepType: 'IntegrationStageStepPMS',
          baseFqn: 'pipeline.stages.build',
        },
      },
    };
    assert.deepEqual(
      listLayoutStages(map, graph, '1').map(stage => stage.nodeIdentifier),
      ['build', 'deploy_to_qa'],
    );
  });
});

describe('steps', () => {
  it('flattens a v1 stage through liteEngineTask, groups, and parallel forks', () => {
    const stage = layout({
      nodeUuid: 'layout-build', name: 'Build', status: 'FAILED', nodeType: 'unified', nodeIdentifier: 'build',
    });
    const graph: GraphLike = {
      nodeMap: {
        'graph-build': {
          identifier: 'build', name: 'Build', stepType: 'IntegrationStageStepPMS',
          baseFqn: 'pipeline.stages.build', status: 'FAILED',
        },
        'graph-qa': {
          identifier: 'deploy_to_qa', name: 'Deploy to QA', stepType: 'IntegrationStageStepPMS',
          baseFqn: 'pipeline.stages.deploy_to_qa', status: 'SKIPPED',
        },
        init: { name: 'Initialize', stepType: 'liteEngineTask', status: 'SUCCESS' },
        clone: {
          name: 'Clone', identifier: 'clone', stepType: 'GitClone', status: 'SUCCESS', logBaseKey: 'clone-key',
        },
        scans: { name: 'Code Scans', identifier: 'code_scans', stepType: 'GROUP', status: 'SKIPPED' },
        'build-test': { name: 'Build and Test', identifier: 'build_and_test', stepType: 'GROUP', status: 'SUCCESS' },
        fork: { name: 'parallel', stepType: 'NG_FORK', status: 'SUCCESS' },
        test: { name: 'Test Intelligence', identifier: 'test', stepType: 'Test', status: 'SUCCESS' },
        'inner-group': { name: 'SBOM', identifier: 'sbom', stepType: 'GROUP', status: 'FAILED' },
        syft: {
          name: 'Syft', identifier: 'syft', stepType: 'Run', status: 'FAILED',
          executableResponses: [{ async: { logKeys: ['syft-key'] } }],
        },
        agent: { name: 'Agent', identifier: 'agent', stepType: 'Run', status: 'SUCCESS' },
      },
      nodeAdjacencyListMap: {
        'graph-build': { children: ['init'], nextIds: ['graph-qa'] },
        'graph-qa': { children: [], nextIds: [] },
        init: { children: [], nextIds: ['clone'] },
        clone: { children: [], nextIds: ['scans'] },
        scans: { children: [], nextIds: ['build-test'] },
        'build-test': { children: ['fork'], nextIds: [] },
        fork: { children: ['test', 'inner-group'], nextIds: [] },
        test: { children: [], nextIds: [] },
        'inner-group': { children: ['syft'], nextIds: [] },
        syft: { children: [], nextIds: ['agent'] },
        agent: { children: [], nextIds: [] },
      },
    };

    const steps = stepsForStage(stage, { build: stage }, graph, '1');
    assert.deepEqual(steps.map(step => step.name), [
      'Clone', 'Code Scans', 'Build and Test', 'Test Intelligence', 'SBOM', 'Syft', 'Agent',
    ]);
    assert.deepEqual(steps.map(step => step.depth), [0, 0, 0, 1, 1, 2, 2]);
    assert.equal(steps.find(step => step.name === 'Build and Test')?.isGroup, true);
    assert.equal(steps.find(step => step.name === 'SBOM')?.isGroup, true);
    assert.equal(steps.find(step => step.name === 'SBOM')?.depth, 1);
    assert.equal(steps.find(step => step.name === 'Test Intelligence')?.parentGroupName, 'Build and Test');
    assert.equal(steps.find(step => step.name === 'Syft')?.parentGroupName, 'SBOM');
    assert.equal(steps.find(step => step.name === 'Agent')?.parentGroupName, 'SBOM');
    assert.equal(steps.find(step => step.name === 'Clone')?.logBaseKey, 'clone-key');
    assert.equal(steps.find(step => step.name === 'Syft')?.logBaseKey, 'syft-key');
    assert.equal(steps.some(step => step.name === 'Deploy to QA'), false);
    assert.equal(steps.some(step => step.name === 'Initialize'), false);
    assert.equal(steps.some(step => step.name === 'parallel'), false);
  });

  it('returns a long sibling chain that used to exceed the nesting limit', () => {
    const ids = Array.from({ length: 20 }, (_, index) => `step-${index}`);
    const nodeMap: NonNullable<GraphLike['nodeMap']> = {
      stage: {
        identifier: 'build', name: 'Build', stepType: 'IntegrationStageStepPMS',
        baseFqn: 'pipeline.stages.build',
      },
    };
    const adjacency: NonNullable<GraphLike['nodeAdjacencyListMap']> = {
      stage: { children: [ids[0]], nextIds: [] },
    };
    ids.forEach((id, index) => {
      nodeMap[id] = { name: `Step ${index}`, stepType: 'Run', status: 'SUCCESS' };
      adjacency[id] = { children: [], nextIds: index < ids.length - 1 ? [ids[index + 1]] : [] };
    });
    const stage = layout({
      nodeUuid: 'layout', name: 'Build', status: 'SUCCESS', nodeType: 'unified', nodeIdentifier: 'build',
    });
    const steps = stepsForStage(stage, { layout: stage }, { nodeMap, nodeAdjacencyListMap: adjacency }, '1');
    assert.equal(steps.length, 20);
    assert.equal(steps[19].name, 'Step 19');
  });

  it('stops on a cycle and does not emit a node twice', () => {
    const stage = layout({
      nodeUuid: 'layout', name: 'Build', status: 'RUNNING', nodeIdentifier: 'build',
    });
    const graph: GraphLike = {
      nodeMap: {
        stage: { identifier: 'build', name: 'Build', stepType: 'IntegrationStageStepPMS', baseFqn: 'pipeline.stages.build' },
        box: { name: 'parallel', stepType: 'NG_FORK', status: 'RUNNING' },
        a: { name: 'A', stepType: 'Run', status: 'RUNNING' },
        b: { name: 'B', stepType: 'Run', status: 'RUNNING' },
      },
      nodeAdjacencyListMap: {
        stage: { children: ['box'], nextIds: [] },
        box: { children: ['a'], nextIds: ['a'] },
        a: { children: [], nextIds: ['b'] },
        b: { children: [], nextIds: ['a'] },
      },
    };
    assert.deepEqual(stepsForStage(stage, { layout: stage }, graph, '0').map(step => step.name), ['A', 'B']);
  });

  it('reflects a later status without reordering the chain', () => {
    const stage = layout({ nodeUuid: 'stage', name: 'Build', status: 'RUNNING', nodeIdentifier: 'build' });
    const graph: GraphLike = {
      nodeMap: {
        stage: { identifier: 'build', name: 'Build', stepType: 'IntegrationStageStepPMS', baseFqn: 'pipeline.stages.build' },
        run: { name: 'Compile', stepType: 'Run', status: 'RUNNING' },
      },
      nodeAdjacencyListMap: {
        stage: { children: ['run'], nextIds: [] },
        run: { children: [], nextIds: [] },
      },
    };
    assert.equal(stepsForStage(stage, { stage }, graph, '0')[0].status, 'RUNNING');
    graph.nodeMap!.run.status = 'FAILED';
    assert.equal(stepsForStage(stage, { stage }, graph, '0')[0].status, 'FAILED');
  });

  it('keeps legacy step-group context and layout fallbacks', () => {
    const stage = layout({
      nodeUuid: 'stage', name: 'Deploy', status: 'SUCCESS',
      edgeLayoutList: { currentNodeChildren: ['script'] },
    });
    const grouped: GraphLike = {
      nodeMap: {
        stage: { name: 'Deploy', stepType: 'DeploymentStageStepPMS', baseFqn: 'pipeline.stages.Deploy' },
        group: { name: 'PR Review', stepType: 'STEP_GROUP', status: 'SUCCESS' },
        agent: { name: 'Agent', identifier: 'agent', stepType: 'Run', status: 'SUCCESS', logBaseKey: 'agent-key' },
      },
      nodeAdjacencyListMap: {
        stage: { children: ['group'], nextIds: [] },
        group: { children: ['agent'], nextIds: [] },
        agent: { children: [], nextIds: [] },
      },
    };
    const groupedSteps = stepsForStage(stage, { stage }, grouped, '0');
    assert.deepEqual(groupedSteps.map(step => step.name), ['PR Review', 'Agent']);
    assert.equal(groupedSteps[0].isGroup, true);
    assert.equal(groupedSteps[0].depth, 0);
    assert.equal(groupedSteps[1].parentGroupName, 'PR Review');
    assert.equal(groupedSteps[1].depth, 1);
    assert.equal(groupedSteps[1].logBaseKey, 'agent-key');

    const layoutOnly = {
      stage,
      script: layout({
        nodeUuid: 'script', name: 'Shell', status: 'SUCCESS', nodeGroup: 'STEP', nodeType: 'ShellScript',
      }),
    };
    assert.deepEqual(stepsForStage(stage, layoutOnly, null, '0').map(step => step.name), ['Shell']);
  });

  it('does not dump v1 layout steps onto a stage the graph cannot match', () => {
    const stage = layout({
      nodeUuid: 'missing', name: 'Unknown', status: 'SKIPPED', nodeType: 'unified', nodeIdentifier: 'missing',
    });
    const map = {
      missing: stage,
      run: layout({ nodeUuid: 'run', name: 'Clone', status: 'SUCCESS', nodeType: 'run' }),
    };
    assert.deepEqual(stepsForStage(stage, map, { nodeMap: {}, nodeAdjacencyListMap: {} }, '1'), []);
  });
});

describe('graph status hash', () => {
  it('changes with status and ignores object key order', () => {
    const first = graphStatusHash({ nodeMap: { b: { status: 'SUCCESS' }, a: { status: 'FAILED' } } });
    const reordered = graphStatusHash({ nodeMap: { a: { status: 'FAILED' }, b: { status: 'SUCCESS' } } });
    const updated = graphStatusHash({ nodeMap: { a: { status: 'RUNNING' }, b: { status: 'SUCCESS' } } });
    assert.equal(first, reordered);
    assert.notEqual(first, updated);
    assert.equal(graphStatusHash(null), 'empty');
  });
});

describe('log keys', () => {
  it('uses the executable response key before logBaseKey', () => {
    assert.equal(resolveLogKey({
      logBaseKey: 'base',
      executableResponses: [{ async: { logKeys: ['', 'from-response'] } }],
    }), 'from-response');
    assert.equal(resolveLogKey({ logBaseKey: 'base', executableResponses: [{ async: { logKeys: [] } }] }), 'base');
    assert.equal(resolveLogKey({}), undefined);
  });

  it('keeps every log unit in order and pairs it with its label', () => {
    const units = resolveLogUnits({
      logBaseKey: 'base',
      executableResponses: [{
        task: { logKeys: ['init', '', 'run'], units: ['Initialize', 'Skipped', ''] },
      }],
    });
    assert.deepEqual(units, [
      { key: 'init', unit: 'Initialize' },
      { key: 'run', unit: 'Section 3' },
    ]);
    assert.deepEqual(resolveLogUnits({ logBaseKey: 'base' }), [
      { key: 'base', unit: 'Section 1' },
    ]);
  });
});
