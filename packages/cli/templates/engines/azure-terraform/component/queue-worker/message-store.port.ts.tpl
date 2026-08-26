export interface StoredMessage {
  id: string;
  payload: unknown;
}

/**
 * Domain port (hexagonal): what the business logic needs from persistence,
 * expressed in domain terms. Implementations live under
 * src/infrastructure/adapters.
 */
export interface MessageStore {
  save(message: StoredMessage): Promise<void>;
}
