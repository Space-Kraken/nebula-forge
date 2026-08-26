import 'reflect-metadata';
import { app } from '@fusion-framework/server';
import { controllers } from './infrastructure/controllers';

/**
 * {{module}}/{{name}} — composition root. This is the module's single API
 * Lambda: every endpoint is a fusion controller registered through the
 * generated barrel (src/infrastructure/controllers/index.ts). Add endpoints
 * with `forge generate endpoint <name> --module {{module}}`.
 */
export const handler = app.createHandler({ controllers });
