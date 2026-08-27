import { RunTaskUC } from './application/run-task.uc';

const useCase = new RunTaskUC();

/**
 * {{module}}/{{name}} — driving adapter (plain hexagonal) for direct
 * invocations and EventBridge schedules. Wiring only: business logic lives in
 * src/application; if the use case needs the outside world, define a port in
 * src/domain/ports, implement it in src/infrastructure/adapters and inject it
 * through the constructor.
 */
export const handler = async (event: unknown): Promise<void> => {
  await useCase.execute(event);
};
