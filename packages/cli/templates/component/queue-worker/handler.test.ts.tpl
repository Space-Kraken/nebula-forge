import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { handler } from '../src/handler';

function sqsEvent(records: { messageId: string; body: string }[]): SQSEvent {
  return { Records: records } as SQSEvent;
}

describe('{{name}} handler', () => {
  it('processes valid messages without failures', async () => {
    const result = await handler(sqsEvent([{ messageId: '1', body: JSON.stringify({ hello: 'world' }) }]));
    expect(result.batchItemFailures).toEqual([]);
  });

  it('reports failed records so they are retried', async () => {
    const result = await handler(
      sqsEvent([
        { messageId: 'ok', body: JSON.stringify({}) },
        { messageId: 'broken', body: '{not json' },
      ]),
    );
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'broken' }]);
  });
});
