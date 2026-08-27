import { Inject, UC, UseCase } from '@fusion-framework/server';
import { MESSAGE_STORE } from '../domain/ports/message-store';
import type { MessageStore } from '../domain/ports/message-store';

/**
 * Use case (hexagonal application layer): pure business logic that talks to
 * the outside world only through domain ports.
 *
 * Always inject with explicit tokens — esbuild does not emit decorator
 * metadata, so implicit injection by parameter type will not work at runtime.
 */
@UseCase()
export class ProcessMessageUC extends UC {
  constructor(@Inject(MESSAGE_STORE) private readonly store: MessageStore) {
    super();
  }

  async execute(messageId: string, payload: unknown): Promise<void> {
    // TODO: business logic
    await this.store.save({ id: messageId, payload });
  }
}
