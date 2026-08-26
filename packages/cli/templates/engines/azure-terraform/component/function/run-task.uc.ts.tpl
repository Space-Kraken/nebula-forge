export interface TaskTrigger {
  source: string;
  type: string;
  data: unknown;
}

/**
 * Use case (hexagonal application layer): pure business logic. If it needs
 * the outside world, define a port under src/domain/ports, implement it in
 * src/infrastructure/adapters and inject it through the constructor.
 */
export class RunTaskUC {
  async execute(trigger: TaskTrigger): Promise<void> {
    console.log('{{name}} executed', JSON.stringify(trigger));
    // TODO: business logic
  }
}
