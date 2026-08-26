import { app } from '@azure/functions';
import type { InvocationContext } from '@azure/functions';
import { ProcessMessageUC } from './application/process-message.uc';
import { ConsoleMessageStore } from './infrastructure/adapters/console-message-store';

// Composition root: bind each domain port to its driven adapter.
const useCase = new ProcessMessageUC(new ConsoleMessageStore());

/**
 * {{module}}/{{name}} — Service Bus driving adapter (hexagonal). One message
 * per invocation; a thrown error abandons the message, so Service Bus retries
 * it and dead-letters it after the configured attempts. forge wires the
 * queue name and the managed-identity connection through app settings.
 */
app.serviceBusQueue('{{name}}', {
  connection: 'ServiceBusConnection',
  queueName: '%WORKER_QUEUE_NAME%',
  handler: async (message: unknown, context: InvocationContext) => {
    await useCase.execute(String(context.triggerMetadata?.messageId ?? context.invocationId), message);
  },
});
