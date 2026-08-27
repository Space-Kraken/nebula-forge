import { UC, UseCase } from '@fusion-framework/server';

/**
 * Use case (hexagonal application layer). Inject dependencies with explicit
 * tokens (@Inject('token')) — esbuild does not emit decorator metadata, so
 * implicit injection by parameter type will not work at runtime.
 */
@UseCase()
export class RunTaskUC extends UC {
  async execute(trigger: unknown): Promise<void> {
    console.log('{{name}} executed', JSON.stringify(trigger));
    // TODO: business logic
  }
}
