import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayStatus, formatLogContent, parseLogLine } from './logFormat';

const info = {
  stepName: 'Print logs',
  stageName: 'Logs',
  pipelineName: 'VS Code Live Logs',
  planExecutionId: 'exec',
  status: 'SUCCESS',
  logLines: [] as string[],
};

describe('log line formatting', () => {
  it('moves a trailing clock to the front and drops the editor line number', () => {
    const text = formatLogContent({
      ...info,
      logLines: ['live-log started', 'live-log line 14 at 23:10:01'],
    });
    assert.match(text, /─+\n\nlive-log started\n23:10:01 live-log line 14$/);
    assert.doesNotMatch(text, /UNKNOWN/);
    assert.doesNotMatch(text, /\bat 23:10:01/);
  });

  it('keeps a real timestamp and a leading level', () => {
    const text = formatLogContent({
      ...info,
      logLines: ['2024-01-15 10:30:45 INFO fetched image', '[ERROR] pull failed'],
    });
    const [infoLine, errorLine] = text.trim().split('\n').slice(-2);
    assert.equal(infoLine, '10:30:45 INFO fetched image');
    assert.equal(errorLine, 'ERROR pull failed');
  });

  it('leaves the word fail inside a sentence as text', () => {
    const parsed = parseLogLine('the step failed to connect', 1);
    assert.equal(parsed.level, undefined);
    assert.equal(parsed.time, undefined);
    assert.equal(parsed.message, 'the step failed to connect');
  });

  it('maps a waiting step to a running header and marks a live tail', () => {
    assert.equal(displayStatus('TaskWaiting'), 'RUNNING');
    const text = formatLogContent({ ...info, status: 'TaskWaiting', live: true, logLines: ['started'] });
    assert.match(text, /status:\s+RUNNING  ·  live/);
  });

  it('drops the live marker once the step succeeds', () => {
    const text = formatLogContent({ ...info, status: 'Success', durationMs: 122700, logLines: ['done'] });
    assert.match(text, /status:\s+SUCCESS$/m);
    assert.match(text, /duration:\s+122\.7s/);
    assert.doesNotMatch(text, /live/);
  });
});
