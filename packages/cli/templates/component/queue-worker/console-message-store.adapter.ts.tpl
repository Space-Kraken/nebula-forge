import type { MessageStore, StoredMessage } from '../../domain/ports/message-store';

/**
 * Driven adapter (hexagonal): placeholder implementation of the MessageStore
 * port. Replace it with a real one — e.g. a DynamoDB adapter reading the table
 * name from the binding env var (process.env.TABLE_<NAME>_NAME) — and rebind
 * it in src/handler.ts.
 */
export class ConsoleMessageStore implements MessageStore {
  async save(message: StoredMessage): Promise<void> {
    console.log('storing message', JSON.stringify(message));
  }
}
