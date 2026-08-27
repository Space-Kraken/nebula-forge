import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { ProcessMessageUC } from './application/process-message.uc';
import { ConsoleMessageStore } from './infrastructure/adapters/console-message-store';

// Composition root: bind each domain port to its driven adapter.
const useCase = new ProcessMessageUC(new ConsoleMessageStore());

/**
 * {{module}}/{{name}} — SQS driving adapter (plain hexagonal). Failed records
 * are reported individually so only they are retried; after the configured
 * retries they land in the dead-letter queue.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      await useCase.execute(record.messageId, JSON.parse(record.body));
    } catch (error) {
      console.error('{{name}} failed for message', record.messageId, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
