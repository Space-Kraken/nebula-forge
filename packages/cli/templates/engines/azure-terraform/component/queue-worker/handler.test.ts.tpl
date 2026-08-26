import { describe, expect, it } from 'vitest';
import { ProcessMessageUC } from '../src/application/process-message.uc';
import type { MessageStore, StoredMessage } from '../src/domain/ports/message-store';

class InMemoryStore implements MessageStore {
  saved: StoredMessage[] = [];
  async save(message: StoredMessage): Promise<void> {
    this.saved.push(message);
  }
}

describe('{{name}} use case', () => {
  it('stores the processed message through its port', async () => {
    const store = new InMemoryStore();
    await new ProcessMessageUC(store).execute('m-1', { hello: 'world' });
    expect(store.saved).toEqual([{ id: 'm-1', payload: { hello: 'world' } }]);
  });
});
