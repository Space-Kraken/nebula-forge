import { describe, expect, it } from 'vitest';
import {
  componentManifestSchema,
  renderArchitectureMarkdown,
  renderArchitectureMermaid,
} from '../src';
import type { ComponentSpec, WorkspaceModel } from '../src';

function component(raw: Record<string, unknown>): ComponentSpec {
  return { ...componentManifestSchema.parse(raw), path: '/tmp/na' } as ComponentSpec;
}

function makeModel(): WorkspaceModel {
  return {
    name: 'shop',
    engine: 'aws-cdk',
    defaultEnvironment: 'dev',
    environments: {
      dev: { region: 'us-east-1' },
      prod: { region: 'us-east-1', production: true },
    },
    root: '/tmp/na',
    domains: [
      {
        name: 'platform',
        path: '/tmp/na',
        components: [component({ name: 'events', type: 'event-bus' })],
      },
      {
        name: 'order-processing',
        description: 'Handles orders | invoices',
        path: '/tmp/na',
        components: [
          component({ name: 'data', type: 'table', config: { partitionKey: { name: 'id' } } }),
          component({ name: 'files', type: 'bucket' }),
          component({ name: 'notices', type: 'topic' }),
          component({
            name: 'jobs',
            type: 'queue-worker',
            config: { subscriptions: [{ bus: 'platform/events', pattern: { source: ['orders'] } }] },
            bindings: [{ component: 'data', access: 'read-write' }],
          }),
          component({
            name: 'intake',
            type: 'http-api',
            bindings: [
              { component: 'jobs', access: 'publish' },
              { component: 'platform/events', access: 'publish' },
            ],
          }),
          component({ name: 'nightly', type: 'function', config: { schedule: 'rate(1 day)' } }),
        ],
      },
      {
        name: 'web',
        path: '/tmp/na',
        components: [component({ name: 'site', type: 'static-site' })],
      },
      { name: 'reporting', path: '/tmp/na', components: [] },
    ],
  };
}

describe('renderArchitectureMermaid', () => {
  it('renders one subgraph per domain with typed nodes and binding edges', () => {
    const mermaid = renderArchitectureMermaid(makeModel());

    expect(mermaid).toMatch(/^flowchart LR/);
    expect(mermaid).toContain('subgraph sg_order_processing["📦 order-processing"]');
    expect(mermaid).toContain('subgraph sg_platform["📦 platform"]');
    // subgraph ids never contain "__" so they cannot collide with node ids
    for (const line of mermaid.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('subgraph ')) {
        expect(trimmed.slice('subgraph '.length).split('[')[0]).not.toContain('__');
      }
    }

    // node shapes by type
    expect(mermaid).toContain('order_processing__intake(["🌐 intake<br/><i>http-api</i>"])');
    expect(mermaid).toContain('order_processing__jobs[["⚙️ jobs<br/><i>queue-worker</i>"]]');
    expect(mermaid).toContain('order_processing__data[("🗄️ data<br/><i>table</i>")]');
    expect(mermaid).toContain('order_processing__notices{{"📣 notices<br/><i>topic</i>"}}');
    expect(mermaid).toContain('platform__events(("🚌 events<br/><i>event-bus</i>"))');
    expect(mermaid).toContain('web__site[/"🖥️ site<br/><i>static-site</i>"/]');

    // same-domain bindings are solid edges
    expect(mermaid).toContain('order_processing__intake -->|"publish"| order_processing__jobs');
    expect(mermaid).toContain('order_processing__jobs -->|"read-write"| order_processing__data');

    // cross-domain integration is dashed: publish binding and subscription
    expect(mermaid).toContain('order_processing__intake -.->|"publish"| platform__events');
    expect(mermaid).toContain('platform__events -.->|"orders"| order_processing__jobs');

    // ids must never contain dashes (invalid in mermaid identifiers)
    for (const line of mermaid.split('\n').slice(1)) {
      const trimmed = line.trim();
      const token = trimmed.startsWith('subgraph ') ? trimmed.slice('subgraph '.length) : trimmed;
      const id = token.split(/[\s[({>-]/)[0];
      expect(id, `id in line: ${line}`).toMatch(/^[A-Za-z0-9_]*$/);
    }
  });

  it('renders a placeholder for domains without components and for empty workspaces', () => {
    const model = makeModel();
    expect(renderArchitectureMermaid(model)).toContain('reporting__empty["(no components)"]');

    const empty = { ...model, domains: [] };
    const mermaid = renderArchitectureMermaid(empty);
    expect(mermaid).toContain('flowchart LR');
    expect(mermaid).toContain('no modules yet');
    // mermaid's HTML sanitizer strips angle brackets from labels
    expect(mermaid).not.toContain('<name>');
  });
});

describe('renderArchitectureMarkdown', () => {
  it('embeds the diagram and documents modules, bindings and env vars', () => {
    const markdown = renderArchitectureMarkdown(makeModel());

    expect(markdown).toContain('# shop — architecture');
    expect(markdown).toContain('```mermaid');
    expect(markdown).toContain('| prod | us-east-1 | (current credentials) | yes |');
    expect(markdown).toContain('## Module `order-processing`');
    expect(markdown).toContain('Stack: `shop-order-processing-<env>`');

    // env vars derived from the shared binding convention; cross-domain gets
    // a domain-qualified name
    expect(markdown).toContain('`TABLE_DATA_NAME`');
    expect(markdown).toContain('`QUEUE_JOBS_URL`');
    expect(markdown).toContain('`BUS_PLATFORM_EVENTS_NAME`');

    // subscriptions are documented next to bindings
    expect(markdown).toContain('⇐ platform/events (subscribed)');

    // pipes in descriptions must not break the layout
    expect(markdown).toContain('Handles orders \\| invoices');
    expect(markdown).toContain('_No components yet._');
    expect(markdown).toContain('forge deploy order-processing --env dev');
  });
});
