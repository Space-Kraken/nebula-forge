export interface {{ucClass}}Request {
  params: Record<string, string | undefined>;
  body?: unknown;
}

/**
 * Use case for {{method}} {{route}} (hexagonal application layer). If it
 * needs the outside world, define a port under src/domain/ports, implement it
 * in src/infrastructure/adapters and inject it through the constructor.
 */
export class {{ucClass}} {
  async execute(request: {{ucClass}}Request): Promise<{ endpoint: string; ok: boolean }> {
    // TODO: business logic (request.params, request.body)
    return { endpoint: '{{name}}', ok: true };
  }
}
