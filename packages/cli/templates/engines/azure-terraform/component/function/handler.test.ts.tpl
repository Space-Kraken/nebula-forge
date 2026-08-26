import { describe, expect, it } from 'vitest';
import { RunTaskUC } from '../src/application/run-task.uc';

describe('{{name}} use case', () => {
  it('executes without failing', async () => {
    await expect(
      new RunTaskUC().execute({ source: 'test', type: 'manual', data: { hello: 'world' } }),
    ).resolves.toBeUndefined();
  });
});
