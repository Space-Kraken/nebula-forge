import 'reflect-metadata';
import { app } from '@fusion-framework/server';
import { controllers } from './infrastructure/controllers';

/**
 * {{module}}/{{name}} — composition root. This is the module's single API
 * Lambda: every endpoint is a fusion controller registered through the
 * generated barrel (src/infrastructure/controllers/index.ts). Add endpoints
 * with `forge generate endpoint <name> --module {{module}}`.
 */
const base = app.createHandler({ controllers });

// CORS_ORIGIN is injected by forge when the api (or its gateway) configures
// cors — preflight is answered by API Gateway; actual responses carry the
// origin from here.
const allowedOrigins = (process.env.CORS_ORIGIN ?? '').split(',').filter(Boolean);

export const handler =
  allowedOrigins.length === 0
    ? base
    : async (...args: Parameters<typeof base>) => {
        const response = await base(...args);
        const requestOrigin = args[0]?.headers?.origin ?? args[0]?.headers?.Origin ?? '';
        const origin = allowedOrigins.includes('*')
          ? '*'
          : allowedOrigins.includes(requestOrigin)
            ? requestOrigin
            : allowedOrigins[0];
        return {
          ...response,
          headers: { ...(response as { headers?: object }).headers, 'access-control-allow-origin': origin },
        };
      };
