import type { MessageStore, StoredMessage } from '../../domain/ports/message-store';

/**
 * Driven adapter (hexagonal): placeholder implementation of the MessageStore
 * port. Replace it with a real one — e.g. a Cosmos DB adapter reading
 * process.env.COSMOS_ENDPOINT and the container from the binding env var
 * (TABLE_<NAME>_NAME) — and rebind it in src/handler.ts.
 */
export class ConsoleMessageStore implements MessageStore {
  async save(message: StoredMessage): Promise<void> {
    console.log('storing message', JSON.stringify(message));
  }
}
