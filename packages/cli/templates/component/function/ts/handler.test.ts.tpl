import { describe, expect, it } from 'vitest';
import { handler } from '../src/handler';

describe('{{name}} handler', () => {
  it('executes the use case without failing', async () => {
    await expect(handler({ source: 'test' })).resolves.toBeUndefined();
  });
});
