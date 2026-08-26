import { describe, expect, it } from 'vitest';
import { handler } from '../src/handler';

// Minimal API Gateway (payload v1) event + Lambda context, as fusion expects.
const event = {
  httpMethod: '{{method}}',
  resource: '{{route}}',
  path: '{{route}}',
  headers: {},
  requestContext: {},
};
const context = { invokedFunctionArn: 'arn:aws:lambda:local:0:function:{{name}}' };

describe('{{method}} {{route}}', () => {
  it('responds through the fusion controller', async () => {
    const result = await (handler as (evt: unknown, ctx: unknown) => Promise<{ statusCode: number; body: string }>)(
      event,
      context,
    );
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ endpoint: '{{name}}', ok: true });
  });
});
