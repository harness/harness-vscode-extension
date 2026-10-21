import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  combineUnitLogs,
  fetchCompletedLogs,
  gatewayBlobUrl,
  parseLogLines,
} from './completedLogs';

const config = {
  baseUrl: 'https://app.harness.io/',
  accountIdentifier: 'acct',
  apiKey: 'pat',
};

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe('completed log parsing', () => {
  it('reads NDJSON envelopes and keeps plain lines', () => {
    const lines = parseLogLines([
      JSON.stringify({ out: 'hello' }),
      'plain',
      JSON.stringify({ message: 'from-message' }),
      '',
    ].join('\n'));
    assert.deepEqual(lines, ['hello', 'plain', 'from-message']);
  });

  it('keeps every line from a long blob', () => {
    const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    assert.equal(parseLogLines(text).length, 250);
  });

  it('labels each unit only when a step has several', () => {
    const units = [
      { key: 'a', unit: 'Initialize' },
      { key: 'b', unit: 'Run' },
    ];
    assert.deepEqual(combineUnitLogs(units, [['one'], ['two']]), [
      '== Initialize ==', 'one', '== Run ==', 'two',
    ]);
    assert.deepEqual(combineUnitLogs(units, [[], ['two']]), ['two']);
    assert.deepEqual(combineUnitLogs([units[0]], [['one']]), ['one']);
  });
});

describe('gateway blob fetch', () => {
  it('requests the raw blob with the API key', async () => {
    const calls: Array<{ url: string; apiKey?: string }> = [];
    const lines = await fetchCompletedLogs(config, [{ key: 'step/key', unit: 'Run' }], {}, {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), apiKey: new Headers(init?.headers).get('x-api-key') ?? undefined });
        return jsonResponse(JSON.stringify({ out: 'built' }));
      },
    });
    assert.deepEqual(lines, ['built']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].apiKey, 'pat');
    assert.equal(calls[0].url, gatewayBlobUrl(config, 'step/key'));
    assert.match(calls[0].url, /\/gateway\/log-service\/blob\?/);
    assert.match(calls[0].url, /accountID=acct/);
    assert.match(calls[0].url, /key=step%2Fkey/);
  });

  it('retries an empty blob only when the step just finished', async () => {
    let calls = 0;
    const waits: number[] = [];
    const now = 1_000_000;
    const lines = await fetchCompletedLogs(
      config,
      [{ key: 'recent', unit: 'Run' }],
      { endTs: now - 10_000 },
      {
        now: () => now,
        sleep: async ms => { waits.push(ms); },
        fetchImpl: async () => jsonResponse(calls++ === 2 ? '{"out":"ready"}' : ' \n'),
      },
    );
    assert.deepEqual(lines, ['ready']);
    assert.deepEqual(waits, [2000, 2000]);

    let oldCalls = 0;
    await fetchCompletedLogs(
      config,
      [{ key: 'old', unit: 'Run' }],
      { endTs: now - 120_000 },
      {
        now: () => now,
        sleep: async () => { throw new Error('old logs must not be retried'); },
        fetchImpl: async () => {
          oldCalls++;
          return jsonResponse('');
        },
      },
    );
    assert.equal(oldCalls, 1);
  });

  it('uses the fallback when the gateway blob is unavailable', async () => {
    const fallbackKeys: string[] = [];
    const lines = await fetchCompletedLogs(
      config,
      [
        { key: 'ok', unit: 'Initialize' },
        { key: 'missing', unit: 'Run' },
      ],
      {},
      {
        fetchImpl: async url => jsonResponse(String(url).includes('missing') ? '' : '{"out":"init"}', String(url).includes('missing') ? 404 : 200),
        fallback: async key => {
          fallbackKeys.push(key);
          return ['from-zip'];
        },
      },
    );
    assert.deepEqual(fallbackKeys, ['missing']);
    assert.deepEqual(lines, ['== Initialize ==', 'init', '== Run ==', 'from-zip']);
  });

  it('falls back when the blob stays empty', async () => {
    let fallbackCalls = 0;
    const lines = await fetchCompletedLogs(config, [{ key: 'empty', unit: 'Run' }], { endTs: 1 }, {
      now: () => 120_000,
      fetchImpl: async () => jsonResponse(''),
      fallback: async () => {
        fallbackCalls++;
        return ['from-stream'];
      },
    });
    assert.deepEqual(lines, ['from-stream']);
    assert.equal(fallbackCalls, 1);
  });
});
