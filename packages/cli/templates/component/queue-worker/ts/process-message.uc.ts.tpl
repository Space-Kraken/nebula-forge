import type { MessageStore } from '../domain/ports/message-store';

/**
 * Use case (hexagonal application layer): pure business logic that talks to
 * the outside world only through domain ports, injected via the constructor.
 */
export class ProcessMessageUC {
  constructor(private readonly store: MessageStore) {}

  async execute(messageId: string, payload: unknown): Promise<void> {
    // TODO: business logic
    await this.store.save({ id: messageId, payload });
  }
}
