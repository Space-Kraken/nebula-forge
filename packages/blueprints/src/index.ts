import { ForgeError } from '@forgecli/core';
import type { Binding, ComponentType } from '@forgecli/core';

export interface BlueprintComponentDef {
  name: string;
  type: ComponentType;
  config?: Record<string, unknown>;
  bindings?: Binding[];
}

export interface BlueprintDomainDef {
  name: string;
  description?: string;
  /** Ordered so binding targets are created before their consumers. */
  components: BlueprintComponentDef[];
}

export interface Blueprint {
  id: string;
  name: string;
  description: string;
  domains: BlueprintDomainDef[];
}

const serverlessApi: Blueprint = {
  id: 'serverless-api',
  name: 'Serverless REST API',
  description: 'HTTP API on Lambda with a DynamoDB table — the classic serverless CRUD starting point.',
  domains: [
    {
      name: 'core',
      description: 'Public HTTP API with its persistence layer',
      components: [
        { name: 'data', type: 'table', config: { partitionKey: { name: 'id' } } },
        { name: 'api', type: 'http-api', bindings: [{ component: 'data', access: 'read-write' }] },
      ],
    },
  ],
};

const queueProcessing: Blueprint = {
  id: 'queue-processing',
  name: 'Asynchronous queue processing',
  description:
    'HTTP intake that enqueues work, an SQS worker with dead-letter queue that processes it, and a DynamoDB table for results.',
  domains: [
    {
      name: 'processing',
      description: 'Asynchronous job intake and processing',
      components: [
        { name: 'data', type: 'table', config: { partitionKey: { name: 'id' } } },
        { name: 'jobs', type: 'queue-worker', bindings: [{ component: 'data', access: 'read-write' }] },
        { name: 'intake', type: 'http-api', bindings: [{ component: 'jobs', access: 'publish' }] },
      ],
    },
  ],
};

const scheduledTasks: Blueprint = {
  id: 'scheduled-tasks',
  name: 'Scheduled tasks',
  description: 'A Lambda that runs on a schedule and persists its results in DynamoDB.',
  domains: [
    {
      name: 'tasks',
      description: 'Recurring background jobs',
      components: [
        { name: 'data', type: 'table', config: { partitionKey: { name: 'id' } } },
        {
          name: 'runner',
          type: 'function',
          config: { schedule: 'rate(1 hour)' },
          bindings: [{ component: 'data', access: 'read-write' }],
        },
      ],
    },
  ],
};

const webApp: Blueprint = {
  id: 'web-app',
  name: 'Web application',
  description:
    'Static frontend on S3 + CloudFront, serverless REST API (one Lambda per domain) and DynamoDB persistence.',
  domains: [
    {
      name: 'web',
      description: 'Static frontend distributed through CloudFront',
      components: [{ name: 'site', type: 'static-site' }],
    },
    {
      name: 'core',
      description: 'Domain API with its persistence layer',
      components: [
        { name: 'data', type: 'table', config: { partitionKey: { name: 'id' } } },
        { name: 'api', type: 'http-api', bindings: [{ component: 'data', access: 'read-write' }] },
      ],
    },
  ],
};

const eventDriven: Blueprint = {
  id: 'event-driven',
  name: 'Event-driven domains',
  description:
    'Domains decoupled through a central EventBridge bus: producers publish by name, consumers subscribe from their own stack.',
  domains: [
    {
      name: 'platform',
      description: 'Shared event bus — the only cross-domain contact point',
      components: [{ name: 'events', type: 'event-bus' }],
    },
    {
      name: 'orders',
      description: 'Order intake; publishes domain events',
      components: [
        { name: 'data', type: 'table', config: { partitionKey: { name: 'id' } } },
        {
          name: 'api',
          type: 'http-api',
          bindings: [
            { component: 'data', access: 'read-write' },
            { component: 'platform/events', access: 'publish' },
          ],
        },
      ],
    },
    {
      name: 'billing',
      description: 'Reacts to order events through its own queue',
      components: [
        { name: 'data', type: 'table', config: { partitionKey: { name: 'id' } } },
        {
          name: 'processor',
          type: 'queue-worker',
          config: { subscriptions: [{ bus: 'platform/events', pattern: { source: ['orders'] } }] },
          bindings: [{ component: 'data', access: 'read-write' }],
        },
      ],
    },
  ],
};

const registry: Record<string, Blueprint> = {
  [serverlessApi.id]: serverlessApi,
  [queueProcessing.id]: queueProcessing,
  [scheduledTasks.id]: scheduledTasks,
  [webApp.id]: webApp,
  [eventDriven.id]: eventDriven,
};

export function listBlueprints(): Blueprint[] {
  return Object.values(registry);
}

export function getBlueprint(id: string): Blueprint {
  const blueprint = registry[id];
  if (!blueprint) {
    throw new ForgeError(
      `Unknown blueprint "${id}"`,
      `Available blueprints: ${Object.keys(registry).join(', ')}`,
    );
  }
  return blueprint;
}
