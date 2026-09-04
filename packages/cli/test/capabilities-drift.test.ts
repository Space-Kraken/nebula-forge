import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILTIN_COMPONENT_TYPES, componentManifestSchema, configureNaming } from '@space-kraken/nebula-forge-core';
import type { ComponentSpec, WorkspaceModel } from '@space-kraken/nebula-forge-core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { awsCdkEngine } from '../src/lib/engines/aws-cdk';
import { azureTerraformEngine } from '../src/lib/engines/azure-terraform';

/**
 * ANTI-DRIFT: the capability manifests each adapter declares are asserted
 * against REAL synthesized output (CloudFormation / Terraform JSON). A new
 * builder resource that is not declared — or a stale declaration nothing
 * emits — fails here, never silently.
 */

const fixturesDir = path.join(__dirname, 'fixtures');
const outdirs: string[] = [];
afterAll(() => {
  for (const dir of outdirs) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => configureNaming(undefined));

function component(raw: Record<string, unknown>): ComponentSpec {
  return { ...componentManifestSchema.parse(raw), path: fixturesDir } as ComponentSpec;
}

const ZONE = { id: 'Z0123456789', name: 'example.com' };

/** Every component type, with every conditional feature exercised. */
function maximalAwsModel(): WorkspaceModel {
  return {
    name: 'shop',
    engine: 'aws-cdk',
    defaultEnvironment: 'dev',
    environments: { dev: { region: 'us-east-1' } },
    root: fixturesDir,
    domains: [
      {
        name: 'platform',
        path: fixturesDir,
        components: [
          component({ name: 'events', type: 'event-bus' }),
          component({ name: 'identity', type: 'auth' }),
          component({
            name: 'edge',
            type: 'gateway',
            config: { auth: 'identity', cors: true, domain: { name: 'api.example.com', zone: ZONE } },
          }),
          component({ name: 'mailer', type: 'email', config: { identity: 'no-reply@example.com' } }),
        ],
      },
      {
        name: 'shop-domain',
        path: fixturesDir,
        components: [
          component({ name: 'data', type: 'table', config: { partitionKey: { name: 'id' }, sortKey: { name: 'sk' } } }),
          component({ name: 'files', type: 'bucket' }),
          component({ name: 'notices', type: 'topic' }),
          component({
            name: 'nightly',
            type: 'function',
            config: {
              entry: 'handler.ts',
              schedule: 'rate(1 hour)',
              subscriptions: [{ bus: 'platform/events', pattern: { source: ['shop'] } }],
            },
            bindings: [
              { component: 'data', access: 'read-write' },
              { component: 'files', access: 'read' },
            ],
          }),
          component({
            name: 'jobs',
            type: 'queue-worker',
            config: { entry: 'handler.ts', subscriptions: [{ bus: 'platform/events', pattern: { source: ['x'] } }] },
            bindings: [{ component: 'notices', access: 'publish' }],
          }),
          component({ name: 'mounted', type: 'http-api', config: { entry: 'handler.ts', mount: 'platform/edge' } }),
        ],
      },
      {
        name: 'web',
        path: fixturesDir,
        components: [
          component({
            name: 'siteapi',
            type: 'http-api',
            config: { entry: 'handler.ts', cors: { origins: ['https://a.example.com'] }, domain: { name: 'x.example.com', zone: ZONE } },
          }),
          component({ name: 'uploads', type: 'bucket' }),
          component({
            name: 'site',
            type: 'static-site',
            config: {
              api: 'siteapi',
              media: 'uploads',
              waf: true,
              domain: { name: 'web.example.com', zone: ZONE },
            },
          }),
        ],
      },
    ],
  };
}

describe('capability manifests match real synthesized output', () => {
  it('every builtin type declares capabilities on the aws adapter', () => {
    for (const type of BUILTIN_COMPONENT_TYPES) {
      expect(awsCdkEngine.capabilities.components[type]?.length, `type ${type}`).toBeGreaterThan(0);
    }
  });

  it('aws: declared CloudFormation types == types present in a maximal synth', async () => {
    const { createApp } = await import('@space-kraken/nebula-forge-engine-cdk');
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-drift-'));
    outdirs.push(outdir);
    const model = maximalAwsModel();
    const { app, stacks } = createApp(model, { environment: 'dev', outdir });

    const present = new Set<string>();
    const assembly = (app as { synth(): { stacks: { template: { Resources?: Record<string, { Type: string }> } }[] } }).synth();
    for (const stack of assembly.stacks) {
      for (const resource of Object.values(stack.template.Resources ?? {})) {
        present.add(resource.Type);
      }
    }
    expect(stacks.size).toBe(3);

    const declared = new Set<string>();
    for (const domain of model.domains) {
      for (const spec of domain.components) {
        for (const type of awsCdkEngine.capabilities.components[spec.type] ?? []) declared.add(type);
      }
    }

    const undeclared = [...present].filter((type) => !declared.has(type));
    const stale = [...declared].filter((type) => !present.has(type));
    expect(undeclared, 'synthesized resource types missing from the capability manifest').toEqual([]);
    expect(stale, 'declared capability types nothing synthesized').toEqual([]);
  }, 120000);

  it('azure: declared Terraform types == types present in a full synth', async () => {
    const { synthesizeDomain } = await import('@space-kraken/nebula-forge-engine-azure-tf');
    const model: WorkspaceModel = {
      name: 'shop',
      engine: 'azure-terraform',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'eastus' } },
      root: fixturesDir,
      domains: [
        {
          name: 'platform',
          path: fixturesDir,
          components: [component({ name: 'events', type: 'event-bus' })],
        },
        {
          name: 'orders',
          path: fixturesDir,
          components: [
            component({ name: 'data', type: 'table', config: { partitionKey: { name: 'id' } } }),
            component({ name: 'files', type: 'bucket' }),
            component({ name: 'notices', type: 'topic' }),
            component({
              name: 'worker',
              type: 'queue-worker',
              config: { entry: 'handler.ts', subscriptions: [{ bus: 'platform/events', pattern: { source: ['orders'] } }] },
              bindings: [
                { component: 'data', access: 'read-write' },
                { component: 'files', access: 'read' },
                { component: 'platform/events', access: 'publish' },
              ],
            }),
            component({
              name: 'nightly',
              type: 'function',
              config: { entry: 'handler.ts', schedule: 'rate(1 hour)', subscriptions: [{ bus: 'platform/events', pattern: { detailType: ['X'] } }] },
              bindings: [{ component: 'data', access: 'read' }],
            }),
          ],
        },
      ],
    };

    const present = new Set<string>();
    for (const domainName of ['platform', 'orders']) {
      const doc = synthesizeDomain(model, domainName, 'dev');
      for (const type of Object.keys(doc.resource as Record<string, unknown>)) present.add(type);
    }

    const declared = new Set<string>(azureTerraformEngine.capabilities.domainShared ?? []);
    for (const domain of model.domains) {
      for (const spec of domain.components) {
        for (const type of azureTerraformEngine.capabilities.components[spec.type] ?? []) declared.add(type);
      }
    }

    const undeclared = [...present].filter((type) => !declared.has(type));
    const stale = [...declared].filter((type) => !present.has(type));
    expect(undeclared, 'synthesized terraform types missing from the capability manifest').toEqual([]);
    expect(stale, 'declared capability types nothing synthesized').toEqual([]);
  }, 60000);
});
