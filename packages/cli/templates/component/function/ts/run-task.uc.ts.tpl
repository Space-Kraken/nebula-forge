/**
 * Use case (hexagonal application layer): pure business logic.
 */
export class RunTaskUC {
  async execute(trigger: unknown): Promise<void> {
    console.log('{{name}} executed', JSON.stringify(trigger));
    // TODO: business logic
  }
}
