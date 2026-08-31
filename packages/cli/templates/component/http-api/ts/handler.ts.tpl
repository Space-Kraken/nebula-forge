import type { APIGatewayEvent, APIGatewayProxyResult } from 'aws-lambda';
import { controllers } from './infrastructure/controllers';

/**
 * {{module}}/{{name}} — composition root (plain hexagonal, no framework).
 * A forge-generated router matches `httpMethod + resource` exactly — the same
 * semantics as API Gateway's route templates — and dispatches to the endpoint
 * controllers registered in the generated barrel. Add endpoints with
 * `forge generate endpoint <name> --module {{module}}`; never put logic here.
 */
const routes = new Map(
  controllers.map((Controller) => {
    const controller = new Controller();
    return [`${controller.method} ${controller.route}`, controller] as const;
  }),
);

const JSON_HEADERS = { 'content-type': 'application/json' };

// CORS_ORIGIN is injected by forge when the api (or its gateway) configures
// cors — preflight is answered by API Gateway; actual responses carry the
// origin from here.
const allowedOrigins = (process.env.CORS_ORIGIN ?? '').split(',').filter(Boolean);
function responseHeaders(event: APIGatewayEvent): Record<string, string> {
  if (allowedOrigins.length === 0) return JSON_HEADERS;
  if (allowedOrigins.includes('*')) return { ...JSON_HEADERS, 'access-control-allow-origin': '*' };
  const origin = event.headers?.origin ?? event.headers?.Origin ?? '';
  return {
    ...JSON_HEADERS,
    'access-control-allow-origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
    vary: 'origin',
  };
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayProxyResult> => {
  const headers = responseHeaders(event);
  const controller = routes.get(`${event.httpMethod} ${event.resource}`);
  if (!controller) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ message: `No route for ${event.httpMethod} ${event.resource}` }),
    };
  }
  try {
    const result = await controller.handle(event);
    if (result === undefined || result === null) {
      return { statusCode: 204, headers, body: '' };
    }
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (error) {
    console.error(`${event.httpMethod} ${event.resource} failed`, error);
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'Internal server error' }) };
  }
};
