import type { APIGatewayEvent } from 'aws-lambda';
import { Controller, Executor, {{methodDecorator}}, UCExecutor } from '@fusion-framework/server';
import { {{ucClass}} } from '../../application/{{name}}.uc';

/**
 * Driving adapter for {{method}} {{route}} — translation only, business logic
 * lives in the use case. The route must stay mirrored in component.json;
 * `forge generate endpoint` keeps both in sync.
 */
@Controller('{{route}}')
export class {{className}} {
  constructor(@Executor() private readonly ucExecutor: UCExecutor) {}

  @{{methodDecorator}}()
  async handle(event: APIGatewayEvent) {
    return this.ucExecutor.execute({{ucClass}}, {
      params: event.pathParameters ?? {},
      body: event.body ? JSON.parse(event.body) : undefined,
    });
  }
}
