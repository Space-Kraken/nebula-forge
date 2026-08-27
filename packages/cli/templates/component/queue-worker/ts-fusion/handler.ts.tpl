import 'reflect-metadata';
import { UCExecutor, container } from '@fusion-framework/server';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { ProcessMessageUC } from './application/process-message.uc';
import { MESSAGE_STORE } from './domain/ports/message-store';
import { ConsoleMessageStore } from './infrastructure/adapters/console-message-store';

// Composition root: bind each domain port to its driven adapter.
container.register(MESSAGE_STORE, { useClass: ConsoleMessageStore });

const ucExecutor = container.resolve(UCExecutor);

/**
 * {{module}}/{{name}} — SQS driving adapter (hexagonal).
 *
 * This adapter intentionally does NOT go through fusion's listener pipeline:
 * fusion catches listener errors and returns a response instead of failing the
 * invocation, which would acknowledge failed messages and lose them. Here each
 * failed record is reported individually, so only failures are retried and,
 * after the configured retries, land in the dead-letter queue. Business logic
 * still lives in fusion use cases under src/application.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      await ucExecutor.execute(ProcessMessageUC, record.messageId, JSON.parse(record.body));
    } catch (error) {
      console.error('{{name}} failed to process message', record.messageId, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
