import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { consumeStreamBuffer, logStreamUrl, openLogStream } from './logStream';

describe('log stream buffering', () => {
  it('parses SSE data frames and plain NDJSON lines the same way', () => {
    const { lines, remainder } = consumeStreamBuffer(
      'data: {"out":"first"}\n' +
      'event: ping\n' +
      '\n' +
      'plain line\n' +
      '{"args":"third'
    );
    assert.deepEqual(lines, ['first', 'plain line']);
    assert.equal(remainder, '{"args":"third');
  });

  it('skips SSE comments and control fields', () => {
    const { lines } = consumeStreamBuffer(': keep-alive\nid: 9\nretry: 3000\ndata: {"message":"hello"}\n');
    assert.deepEqual(lines, ['hello']);
  });

  it('builds the gateway stream url with the key and account id in the query', () => {
    const url = logStreamUrl(
      { baseUrl: 'https://app.harness.io/', accountIdentifier: 'acct', apiKey: 'pat' },
      'log key',
    );
    assert.equal(url, 'https://app.harness.io/gateway/log-service/stream?accountID=acct&key=log+key');
  });
});

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

describe('log stream tailing', () => {
  it('delivers lines as chunks arrive and signals done when the body ends', async () => {
    const received: string[][] = [];
    let done = false;
    const fetchImpl = (async () => streamResponse([
      'data: {"out":"line one"}\n',
      'data: {"out":"line two"}\ndata: {"out":"line three"}\n',
    ])) as unknown as typeof fetch;

    await new Promise<void>(resolve => {
      openLogStream(
        { baseUrl: 'https://app.harness.io', accountIdentifier: 'acct', apiKey: 'pat' },
        'key',
        {
          onLines: batch => received.push(batch),
          onDone: () => { done = true; resolve(); },
        },
        { fetchImpl },
      );
    });

    assert.equal(done, true);
    assert.deepEqual(received.flat(), ['line one', 'line two', 'line three']);
  });

  it('stops delivering once close() is called', async () => {
    let doneCount = 0;
    const fetchImpl = (async () => streamResponse(['data: {"out":"only"}\n'])) as unknown as typeof fetch;
    const handle = openLogStream(
      { baseUrl: 'https://app.harness.io', accountIdentifier: 'acct', apiKey: 'pat' },
      'key',
      { onLines: () => {}, onDone: () => { doneCount++; } },
      { fetchImpl },
    );
    handle.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(doneCount, 0);
  });

  it('reports onDone without onLines when the endpoint rejects the request', async () => {
    let lineBatches = 0;
    let done = false;
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await new Promise<void>(resolve => {
      openLogStream(
        { baseUrl: 'https://app.harness.io', accountIdentifier: 'acct', apiKey: 'pat' },
        'key',
        { onLines: () => { lineBatches++; }, onDone: () => { done = true; resolve(); } },
        { fetchImpl },
      );
    });
    assert.equal(lineBatches, 0);
    assert.equal(done, true);
  });
});
