import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { componentManifestSchema } from '@forgecli/core';
import type { ComponentSpec, WorkspaceModel } from '@forgecli/core';
import { afterAll, describe, expect, it } from 'vitest';
import { packageFunction, storageAccountName, synthesizeDomain, toNcrontab } from '../src';

const fixturesDir = path.join(__dirname, 'fixtures');
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function component(raw: Record<string, unknown>): ComponentSpec {
  return { ...componentManifestSchema.parse(raw), path: fixturesDir } as ComponentSpec;
}

function makeModel(): WorkspaceModel {
  return {
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
            config: {
              entry: 'handler.ts',
              maxRetries: 3,
              subscriptions: [{ bus: 'platform/events', pattern: { source: ['orders'] } }],
            },
            bindings: [
              { component: 'data', access: 'read-write' },
              { component: 'platform/events', access: 'publish' },
            ],
          }),
          component({
            name: 'nightly',
            type: 'function',
            config: {
              entry: 'handler.ts',
              schedule: 'rate(1 hour)',
              subscriptions: [{ bus: 'platform/events', pattern: { detailType: ['OrderPlaced'] } }],
            },
            bindings: [{ component: 'files', access: 'read' }],
          }),
        ],
      },
    ],
  };
}

describe('synthesizeDomain', () => {
  const doc = synthesizeDomain(makeModel(), 'orders', 'dev');
  const resources = doc.resource as Record<string, Record<string, any>>;

  it('creates the domain resource group and lazy shared infrastructure', () => {
    expect(resources.azurerm_resource_group.domain.name).toBe('rg-shop-orders-dev');
    expect(resources.azurerm_storage_account.domain.name).toMatch(/^st[a-z0-9]{1,22}$/);
    expect(resources.azurerm_storage_account.domain.name.length).toBeLessThanOrEqual(24);
    expect(resources.azurerm_cosmosdb_account.domain.capabilities).toEqual([{ name: 'EnableServerless' }]);
    expect(resources.azurerm_servicebus_namespace.domain.sku).toBe('Standard');
    expect(resources.azurerm_service_plan.domain.sku_name).toBe('Y1');
  });

  it('maps components to Azure resources with forge semantics', () => {
    expect(resources.azurerm_cosmosdb_sql_container.data.partition_key_paths).toEqual(['/id']);
    expect(resources.azurerm_storage_container.files.container_access_type).toBe('private');
    expect(resources.azurerm_servicebus_queue.worker_queue.max_delivery_count).toBe(4);
    expect(resources.azurerm_servicebus_topic.notices).toBeDefined();
  });

  it('wires bindings as managed-identity RBAC plus discovery app settings', () => {
    const worker = resources.azurerm_linux_function_app.worker;
    expect(worker.identity).toEqual({ type: 'SystemAssigned' });
    expect(worker.app_settings.TABLE_DATA_NAME).toBe('data');
    expect(worker.app_settings.COSMOS_DATABASE).toBe('app');
    expect(worker.app_settings.WORKER_QUEUE_NAME).toBe('worker');
    expect(worker.app_settings.ServiceBusConnection__fullyQualifiedNamespace).toContain('servicebus.windows.net');
    expect(worker.zip_deploy_file).toBe('${path.module}/assets/worker.zip');

    // cosmos data-plane role scoped to the container, GUID name deterministic
    const cosmosRole = resources.azurerm_cosmosdb_sql_role_assignment.worker_orders_data;
    expect(cosmosRole.scope).toContain('/dbs/app/colls/data');
    expect(cosmosRole.role_definition_id).toContain('00000000-0000-0000-0000-000000000002');
    expect(cosmosRole.name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // read-only bucket binding gets the Reader role
    const bucketRole = resources.azurerm_role_assignment.nightly_orders_files;
    expect(bucketRole.role_definition_name).toBe('Storage Blob Data Reader');

    // the worker can receive from its own queue
    expect(resources.azurerm_role_assignment.worker_own_queue.role_definition_name).toBe(
      'Azure Service Bus Data Receiver',
    );
  });

  it('reaches cross-domain event buses by deterministic name via data sources', () => {
    const data = doc.data as Record<string, Record<string, any>>;
    expect(data.azurerm_eventgrid_topic.platform_events).toEqual({
      name: 'shop-platform-events-dev',
      resource_group_name: 'rg-shop-platform-dev',
    });
    const publishRole = resources.azurerm_role_assignment.worker_platform_events;
    expect(publishRole.role_definition_name).toBe('EventGrid Data Sender');
    expect(publishRole.scope).toBe('${data.azurerm_eventgrid_topic.platform_events.id}');
    expect(resources.azurerm_linux_function_app.worker.app_settings.BUS_PLATFORM_EVENTS_NAME).toBe(
      '${data.azurerm_eventgrid_topic.platform_events.name}',
    );
    expect(JSON.stringify(doc)).not.toContain('terraform_remote_state');
  });

  it('creates Event Grid subscriptions for workers (queue) and functions (function endpoint)', () => {
    const workerSub = resources.azurerm_eventgrid_event_subscription.worker_sub0;
    expect(workerSub.service_bus_queue_endpoint_id).toBe('${azurerm_servicebus_queue.worker_queue.id}');
    expect(workerSub.advanced_filter).toEqual({ string_in: [{ key: 'subject', values: ['orders'] }] });

    const fnSub = resources.azurerm_eventgrid_event_subscription.nightly_sub0;
    expect(fnSub.azure_function_endpoint.function_id).toContain('/functions/nightly');
    expect(fnSub.included_event_types).toEqual(['OrderPlaced']);
  });

  it('converts rate() schedules to NCRONTAB timer settings', () => {
    expect(resources.azurerm_linux_function_app.nightly.app_settings.TIMER_SCHEDULE).toBe('0 0 */1 * * *');
    expect(toNcrontab('rate(5 minutes)')).toBe('0 */5 * * * *');
    expect(() => toNcrontab('cron(0 12 * * ? *)')).toThrow(/not supported on the azure-terraform engine/);
  });

  it('keeps terraform state outside the synthesized tree', () => {
    const backend = (doc.terraform as any).backend.local.path as string;
    expect(backend).toBe('../../../../.tfstate/shop-orders-dev.tfstate');
  });

  it('switches to the azurerm backend once forge bootstrap recorded it', () => {
    const model = makeModel();
    model.environments.dev.state = {
      resourceGroup: 'rg-shop-tfstate-dev',
      storageAccount: 'stshopdev0123456789ab',
      container: 'tfstate',
    };
    const bootstrapped = synthesizeDomain(model, 'orders', 'dev');
    expect((bootstrapped.terraform as any).backend).toEqual({
      azurerm: {
        resource_group_name: 'rg-shop-tfstate-dev',
        storage_account_name: 'stshopdev0123456789ab',
        container_name: 'tfstate',
        key: 'shop-orders-dev.tfstate',
      },
    });
  });

  it('rejects component types that are not supported yet, with guidance', () => {
    const model = makeModel();
    model.domains[1].components.push(component({ name: 'api', type: 'http-api' }));
    expect(() => synthesizeDomain(model, 'orders', 'dev')).toThrow(/not supported by the azure-terraform engine yet/);
  });

  it('renders function app names with the workspace naming pattern; hashed helpers keep constraints', () => {
    const model = makeModel();
    model.naming = { pattern: 'corp-{module}-{name}-{env}' };
    const custom = synthesizeDomain(model, 'orders', 'dev');
    const customResources = custom.resource as Record<string, Record<string, any>>;
    expect(customResources.azurerm_linux_function_app.worker.name).toBe('fn-corp-orders-worker-dev');
    // domain-level shared infra keeps its short, globally-unique hashed names
    expect(customResources.azurerm_storage_account.domain.name).toMatch(/^st[a-z0-9]{1,22}$/);
    expect(customResources.azurerm_storage_account.domain.name.length).toBeLessThanOrEqual(24);
  });

  it('applies workspace tags to taggable resources only, forge tags winning on conflict', () => {
    const model = makeModel();
    model.tags = { 'cost-center': 'cc-1234', app: '{project}', 'forge-app': 'spoofed' };
    const tagged = synthesizeDomain(model, 'orders', 'dev');
    const taggedResources = tagged.resource as Record<string, Record<string, any>>;
    expect(taggedResources.azurerm_linux_function_app.worker.tags).toMatchObject({
      'cost-center': 'cc-1234',
      app: 'shop',
    });
    expect(taggedResources.azurerm_resource_group.domain.tags['forge-app']).toBe('shop');
    expect(taggedResources.azurerm_resource_group.domain.tags['cost-center']).toBe('cc-1234');
    // role assignments and queues do not accept tags — never tagged
    expect(taggedResources.azurerm_role_assignment.worker_own_queue.tags).toBeUndefined();
    expect(taggedResources.azurerm_servicebus_queue.worker_queue.tags).toBeUndefined();
  });

  it('rejects component packs until azure builders exist', () => {
    const model = makeModel();
    model.domains[1].packComponents = [
      { name: 'vault', type: 'secret', bindings: [], config: {}, path: fixturesDir, pack: 'test-pack' },
    ];
    expect(() => synthesizeDomain(model, 'orders', 'dev')).toThrow(/component packs, which are not supported/);
  });

  it('runs domains/<module>/extend.ts against the terraform document', () => {
    const model = makeModel();
    model.domains[1] = { ...model.domains[1], path: path.join(fixturesDir, 'extended') };
    for (const component of model.domains[1].components) {
      (component as { path: string }).path = fixturesDir;
    }
    const doc = synthesizeDomain(model, 'orders', 'dev');
    expect(doc.output.extended).toEqual({ value: 'from-extend-dev' });
  });

  it('rejects the ts-fusion runtime until fusion-azure exists', () => {
    const model = makeModel();
    model.domains[1].components.push(
      component({ name: 'legacy', type: 'function', config: { entry: 'handler.ts', runtime: 'ts-fusion' } }),
    );
    expect(() => synthesizeDomain(model, 'orders', 'dev')).toThrow(/ts-fusion runtime, which is not available/);
  });

  it('rejects fifo workers with a clear error', () => {
    const model = makeModel();
    model.domains[1].components.push(
      component({ name: 'ordered', type: 'queue-worker', config: { fifo: true } }),
    );
    expect(() => synthesizeDomain(model, 'orders', 'dev')).toThrow(/fifo queue-workers are not supported/);
  });
});

describe('naming', () => {
  it('storage account names stay deterministic, short and lowercase-alphanumeric', () => {
    const name = storageAccountName('my-very-long-app-name', 'my-long-domain', 'production');
    expect(name).toMatch(/^st[a-z0-9]+$/);
    expect(name.length).toBeLessThanOrEqual(24);
    expect(name).toBe(storageAccountName('my-very-long-app-name', 'my-long-domain', 'production'));
  });
});

describe('packageFunction', () => {
  it('bundles the handler with host.json and package.json into a zip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-az-pkg-'));
    tempDirs.push(dir);
    const outFile = path.join(dir, 'worker.zip');
    packageFunction(
      component({ name: 'worker', type: 'queue-worker', config: { entry: 'handler.ts' } }),
      outFile,
    );
    const entries = new AdmZip(outFile).getEntries().map((entry) => entry.entryName);
    expect(entries.sort()).toEqual(['host.json', 'index.js', 'package.json']);
  });
});
