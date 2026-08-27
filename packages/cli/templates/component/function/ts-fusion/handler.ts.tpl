import 'reflect-metadata';
import { UCExecutor, container } from '@fusion-framework/server';
import { RunTaskUC } from './application/run-task.uc';

const ucExecutor = container.resolve(UCExecutor);

/**
 * {{module}}/{{name}} — driving adapter (hexagonal) for direct invocations and
 * EventBridge schedules. Keep it thin: it only hands the trigger to the use
 * case. Business logic lives in src/application; if the use case needs the
 * outside world, define a port in src/domain/ports, implement it in
 * src/infrastructure/adapters and bind it here with container.register.
 */
export const handler = async (event: unknown): Promise<void> => {
  await ucExecutor.execute(RunTaskUC, event);
};
