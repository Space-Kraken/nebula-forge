import { UC, UseCase } from '@fusion-framework/server';

export interface {{ucClass}}Request {
  params: Record<string, string | undefined>;
  body?: unknown;
}

/**
 * Use case for {{method}} {{route}} (hexagonal application layer). Depends
 * only on domain ports — inject them with explicit tokens (@Inject('token'));
 * esbuild does not emit decorator metadata, so injection by parameter type
 * will not work at runtime.
 */
@UseCase()
export class {{ucClass}} extends UC {
  async execute(request: {{ucClass}}Request): Promise<{ endpoint: string; ok: boolean }> {
    // TODO: business logic (request.params, request.body)
    return { endpoint: '{{name}}', ok: true };
  }
}
