import type { APIGatewayEvent } from 'aws-lambda';
import { {{ucClass}} } from '../../application/{{name}}.uc';

/**
 * Driving adapter for {{method}} {{route}} — translation only, business logic
 * lives in the use case. `method` and `route` must stay mirrored in
 * component.json; `forge generate endpoint` keeps all three in sync.
 */
export class {{className}} {
  readonly method = '{{method}}';
  readonly route = '{{route}}';

  async handle(event: APIGatewayEvent) {
    return new {{ucClass}}().execute({
      params: event.pathParameters ?? {},
      body: event.body ? JSON.parse(event.body) : undefined,
    });
  }
}
