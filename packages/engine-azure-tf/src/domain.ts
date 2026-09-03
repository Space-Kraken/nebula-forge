import {
  bindingEnvVarFor,
  builtinTagsFor,
  configureNaming,
  ForgeError,
  renderTags,
  resolveBinding,
  resourceNameFor,
  stackNameFor,
} from '@forgecli/core';
import type { ComponentSpec, DomainSpec, WorkspaceModel } from '@forgecli/core';
import { applyExtension } from './extend';
import { deterministicGuid, globalName, resourceGroupName, storageAccountName, tfLabel } from './names';
import { toNcrontab } from './schedule';
import { addData, addResource, ref, TfDocument } from './tf';

/** Component types the azure-terraform engine does not cover yet. */
export const AZURE_UNSUPPORTED_TYPES = ['http-api', 'static-site', 'gateway', 'auth', 'email'] as const;

const COSMOS_DATA_READER = '00000000-0000-0000-0000-000000000001';
const COSMOS_DATA_CONTRIBUTOR = '00000000-0000-0000-0000-000000000002';

interface Ctx {
  model: WorkspaceModel;
  domain: DomainSpec;
  environment: string;
  region: string;
}

function assertSupported(ctx: Ctx): void {
  if ((ctx.domain.packComponents ?? []).length > 0) {
    throw new ForgeError(
      `Module "${ctx.domain.name}" uses component packs, which are not supported on azure-terraform yet`,
      'Pack builders for Azure arrive in a later phase — packs are aws-cdk only for now.',
    );
  }
  for (const component of ctx.domain.components) {
    if ((AZURE_UNSUPPORTED_TYPES as readonly string[]).includes(component.type)) {
      throw new ForgeError(
        `Component "${ctx.domain.name}/${component.name}" (${component.type}) is not supported by the azure-terraform engine yet`,
        'Phase 1 covers function, queue-worker, table, bucket, topic and event-bus. The API layer (http-api) arrives with fusion-azure; static-site arrives with Front Door support.',
      );
    }
    if (
      (component.type === 'function' || component.type === 'queue-worker' || component.type === 'http-api') &&
      component.config.runtime === 'ts-fusion'
    ) {
      throw new ForgeError(
        `Component "${ctx.domain.name}/${component.name}" requests the ts-fusion runtime, which is not available on Azure yet`,
        'fusion-azure has not been released — use the plain "ts" runtime (the default on azure-terraform).',
      );
    }
    if (component.type === 'queue-worker' && component.config.fifo) {
      throw new ForgeError(
        `Component "${ctx.domain.name}/${component.name}": fifo queue-workers are not supported on azure-terraform yet`,
        'Service Bus sessions need a session-aware worker; use a standard queue-worker on Azure for now.',
      );
    }
  }
}

type FunctionLike = Extract<ComponentSpec, { type: 'function' | 'queue-worker' }>;

function isFunctionLike(component: ComponentSpec): component is FunctionLike {
  return component.type === 'function' || component.type === 'queue-worker';
}

/**
 * Synthesizes one domain into a self-contained Terraform JSON document:
 * one resource group per domain, shared storage/Cosmos/Service Bus per domain
 * (created lazily), one Function App per function-like component, RBAC role
 * assignments for bindings and Event Grid subscriptions for events.
 * Cross-domain buses are looked up by deterministic name — no cross-state
 * references, so every domain keeps deploying independently.
 */
export function synthesizeDomain(
  model: WorkspaceModel,
  domainName: string,
  environment: string,
): TfDocument {
  const domain = model.domains.find((candidate) => candidate.name === domainName);
  if (!domain) {
    throw new ForgeError(
      `Unknown domain "${domainName}"`,
      `Available domains: ${model.domains.map((d) => d.name).join(', ') || '(none)'}`,
    );
  }
  const envSpec = model.environments[environment];
  if (!envSpec) {
    throw new ForgeError(
      `Environment "${environment}" is not declared in forge.json`,
      `Available environments: ${Object.keys(model.environments).join(', ')}`,
    );
  }
  // Names must render with THIS workspace's convention, even when the model
  // was built without loadWorkspace (tests, embedding).
  configureNaming(model.naming);
  const ctx: Ctx = { model, domain, environment, region: envSpec.region };
  assertSupported(ctx);

  const doc: TfDocument = {
    terraform: {
      required_version: '>= 1.5.0',
      required_providers: { azurerm: { source: 'hashicorp/azurerm', version: '~> 4.0' } },
      backend: envSpec.state
        ? {
            // Remote state provisioned by `forge bootstrap` — one blob per
            // domain, so domains keep deploying independently.
            azurerm: {
              resource_group_name: envSpec.state.resourceGroup,
              storage_account_name: envSpec.state.storageAccount,
              container_name: envSpec.state.container,
              key: `${stackNameFor(model.name, domain.name, environment)}.tfstate`,
            },
          }
        : {
            // Module dir is .forge/azure/<env>/<domain>/ — local state lives at
            // the workspace root so a synth never wipes it. Run `forge
            // bootstrap` to move it to a shared remote backend.
            local: { path: `../../../../.tfstate/${stackNameFor(model.name, domain.name, environment)}.tfstate` },
          },
    },
    provider: {
      azurerm: {
        features: {},
        ...(envSpec.account ? { subscription_id: envSpec.account } : {}),
      },
    },
    data: {},
    resource: {},
    output: {},
  };

  const rg = addResource(doc, 'azurerm_resource_group', 'domain', {
    name: resourceGroupName(model.name, domain.name, environment),
    location: ctx.region,
    tags: builtinTagsFor(
      { app: 'forge-app', domain: 'forge-domain', environment: 'forge-environment' },
      model.tags,
      { app: model.name, domain: domain.name, environment },
    ),
  });
  const rgName = ref(rg, 'name');
  const rgLocation = ref(rg, 'location');

  const functionLike = domain.components.filter(isFunctionLike);
  const needsStorage = functionLike.length > 0 || domain.components.some((c) => c.type === 'bucket');
  const needsCosmos = domain.components.some((c) => c.type === 'table');
  const needsServiceBus =
    domain.components.some((c) => c.type === 'topic') || domain.components.some((c) => c.type === 'queue-worker');

  let storage: string | undefined;
  if (needsStorage) {
    storage = addResource(doc, 'azurerm_storage_account', 'domain', {
      name: storageAccountName(model.name, domain.name, environment),
      resource_group_name: rgName,
      location: rgLocation,
      account_tier: 'Standard',
      account_replication_type: 'LRS',
      min_tls_version: 'TLS1_2',
      allow_nested_items_to_be_public: false,
    });
  }

  let cosmos: string | undefined;
  let cosmosDb: string | undefined;
  const cosmosDbName = 'app';
  if (needsCosmos) {
    cosmos = addResource(doc, 'azurerm_cosmosdb_account', 'domain', {
      name: globalName('cos', [model.name, domain.name, environment], 44),
      resource_group_name: rgName,
      location: rgLocation,
      offer_type: 'Standard',
      kind: 'GlobalDocumentDB',
      capabilities: [{ name: 'EnableServerless' }],
      consistency_policy: { consistency_level: 'Session' },
      geo_location: [{ location: rgLocation, failover_priority: 0 }],
    });
    cosmosDb = addResource(doc, 'azurerm_cosmosdb_sql_database', 'domain', {
      name: cosmosDbName,
      resource_group_name: rgName,
      account_name: ref(cosmos, 'name'),
    });
  }

  let serviceBus: string | undefined;
  if (needsServiceBus) {
    serviceBus = addResource(doc, 'azurerm_servicebus_namespace', 'domain', {
      name: globalName('sb', [model.name, domain.name, environment], 50),
      resource_group_name: rgName,
      location: rgLocation,
      sku: 'Standard',
    });
  }

  let plan: string | undefined;
  if (functionLike.length > 0) {
    plan = addResource(doc, 'azurerm_service_plan', 'domain', {
      name: `plan-${model.name}-${domain.name}-${environment}`,
      resource_group_name: rgName,
      location: rgLocation,
      os_type: 'Linux',
      sku_name: 'Y1',
    });
  }

  // Pass 1 — passive resources, addressable by later passes.
  const containers = new Map<string, string>();
  const tables = new Map<string, string>();
  const queues = new Map<string, string>();
  const topics = new Map<string, string>();
  const eventBuses = new Map<string, string>();

  for (const component of domain.components) {
    const label = tfLabel(component.name);
    switch (component.type) {
      case 'bucket':
        containers.set(
          component.name,
          addResource(doc, 'azurerm_storage_container', label, {
            name: component.name,
            storage_account_name: ref(storage!, 'name'),
            container_access_type: 'private',
          }),
        );
        break;
      case 'table':
        tables.set(
          component.name,
          addResource(doc, 'azurerm_cosmosdb_sql_container', label, {
            name: component.name,
            resource_group_name: rgName,
            account_name: ref(cosmos!, 'name'),
            database_name: ref(cosmosDb!, 'name'),
            partition_key_paths: [`/${component.config.partitionKey.name}`],
            ...(component.config.timeToLiveAttribute ? { default_ttl: -1 } : {}),
          }),
        );
        break;
      case 'queue-worker':
        queues.set(
          component.name,
          addResource(doc, 'azurerm_servicebus_queue', `${label}_queue`, {
            name: component.name,
            namespace_id: ref(serviceBus!, 'id'),
            max_delivery_count: component.config.maxRetries + 1,
            dead_lettering_on_message_expiration: true,
          }),
        );
        break;
      case 'topic':
        topics.set(
          component.name,
          addResource(doc, 'azurerm_servicebus_topic', label, {
            name: component.name,
            namespace_id: ref(serviceBus!, 'id'),
          }),
        );
        break;
      case 'event-bus':
        eventBuses.set(
          component.name,
          addResource(doc, 'azurerm_eventgrid_topic', label, {
            // Deterministic: other domains publish/subscribe by this name.
            name: resourceNameFor(model.name, domain.name, component.name, environment),
            resource_group_name: rgName,
            location: rgLocation,
          }),
        );
        break;
      default:
        break;
    }
  }

  /** Event Grid topic address (resource in this domain, data source otherwise). */
  const remoteBusData = new Map<string, string>();
  function busAddress(busDomain: string, busName: string): string {
    if (busDomain === ctx.domain.name) return eventBuses.get(busName)!;
    const key = `${busDomain}/${busName}`;
    if (!remoteBusData.has(key)) {
      remoteBusData.set(
        key,
        addData(doc, 'azurerm_eventgrid_topic', tfLabel(busDomain, busName), {
          name: resourceNameFor(model.name, busDomain, busName, environment),
          resource_group_name: resourceGroupName(model.name, busDomain, environment),
        }),
      );
    }
    return remoteBusData.get(key)!;
  }

  // Pass 2 — function apps with their settings, then RBAC and subscriptions.
  for (const component of functionLike) {
    const label = tfLabel(component.name);
    const settings: Record<string, string> = {
      FUNCTIONS_WORKER_RUNTIME: 'node',
      WEBSITE_RUN_FROM_PACKAGE: '1',
      ...component.config.environment,
    };
    const roleAssignments: { label: string; scope: string; role?: string; cosmos?: 'read' | 'write' }[] = [];

    if (component.type === 'queue-worker') {
      settings.ServiceBusConnection__fullyQualifiedNamespace = `${ref(serviceBus!, 'name')}.servicebus.windows.net`;
      settings.WORKER_QUEUE_NAME = component.name;
      roleAssignments.push({
        label: tfLabel(component.name, 'own_queue'),
        scope: ref(queues.get(component.name)!, 'id'),
        role: 'Azure Service Bus Data Receiver',
      });
    }
    if (component.type === 'function' && component.config.schedule) {
      settings.TIMER_SCHEDULE = toNcrontab(component.config.schedule);
    }

    for (const binding of component.bindings) {
      const resolved = resolveBinding(model, domain, binding);
      if (!resolved) {
        throw new ForgeError(`Cannot resolve binding "${binding.component}" of "${component.name}"`);
      }
      const target = resolved.component;
      const crossDomain = resolved.domain.name !== domain.name;
      const envName = crossDomain ? `${resolved.domain.name}-${target.name}` : target.name;
      const envVar = bindingEnvVarFor(target.type, envName);
      const raLabel = tfLabel(component.name, resolved.domain.name, target.name);

      switch (target.type) {
        case 'table': {
          settings[envVar!] = target.name;
          settings.COSMOS_ENDPOINT = ref(cosmos!, 'endpoint');
          settings.COSMOS_DATABASE = cosmosDbName;
          roleAssignments.push({
            label: raLabel,
            scope: `${ref(cosmos!, 'id')}/dbs/${cosmosDbName}/colls/${target.name}`,
            cosmos: binding.access === 'read' ? 'read' : 'write',
          });
          break;
        }
        case 'bucket': {
          settings[envVar!] = target.name;
          settings.STORAGE_BLOB_ENDPOINT = ref(storage!, 'primary_blob_endpoint');
          roleAssignments.push({
            label: raLabel,
            scope: ref(containers.get(target.name)!, 'resource_manager_id'),
            role: binding.access === 'read' ? 'Storage Blob Data Reader' : 'Storage Blob Data Contributor',
          });
          break;
        }
        case 'queue-worker': {
          settings[envVar!] = target.name;
          settings.SERVICE_BUS_NAMESPACE = `${ref(serviceBus!, 'name')}.servicebus.windows.net`;
          roleAssignments.push({
            label: raLabel,
            scope: ref(queues.get(target.name)!, 'id'),
            role: 'Azure Service Bus Data Sender',
          });
          break;
        }
        case 'topic': {
          settings[envVar!] = target.name;
          settings.SERVICE_BUS_NAMESPACE = `${ref(serviceBus!, 'name')}.servicebus.windows.net`;
          roleAssignments.push({
            label: raLabel,
            scope: ref(topics.get(target.name)!, 'id'),
            role: 'Azure Service Bus Data Sender',
          });
          break;
        }
        case 'event-bus': {
          const address = busAddress(resolved.domain.name, target.name);
          settings[envVar!] = ref(address, 'name');
          settings[`${envVar!.replace(/_NAME$/, '')}_ENDPOINT`] = ref(address, 'endpoint');
          roleAssignments.push({
            label: raLabel,
            scope: ref(address, 'id'),
            role: 'EventGrid Data Sender',
          });
          break;
        }
        default:
          throw new ForgeError(
            `Component "${component.name}" binds to "${binding.component}" (${target.type}), which is not bindable on azure-terraform`,
          );
      }
    }

    const app = addResource(doc, 'azurerm_linux_function_app', label, {
      // The workspace naming pattern feeds the name; the helper still owns
      // the 60-char global-uniqueness constraint (hash-truncated when long).
      name: globalName('fn', [resourceNameFor(model.name, domain.name, component.name, environment)], 60),
      resource_group_name: rgName,
      location: rgLocation,
      service_plan_id: ref(plan!, 'id'),
      storage_account_name: ref(storage!, 'name'),
      storage_account_access_key: ref(storage!, 'primary_access_key'),
      https_only: true,
      site_config: { application_stack: { node_version: '20' } },
      identity: { type: 'SystemAssigned' },
      app_settings: settings,
      zip_deploy_file: `\${path.module}/assets/${component.name}.zip`,
    });
    const principal = ref(app, 'identity[0].principal_id');

    for (const assignment of roleAssignments) {
      if (assignment.cosmos) {
        addResource(doc, 'azurerm_cosmosdb_sql_role_assignment', assignment.label, {
          name: deterministicGuid(model.name, domain.name, component.name, assignment.label, environment),
          resource_group_name: rgName,
          account_name: ref(cosmos!, 'name'),
          role_definition_id: `${ref(cosmos!, 'id')}/sqlRoleDefinitions/${
            assignment.cosmos === 'read' ? COSMOS_DATA_READER : COSMOS_DATA_CONTRIBUTOR
          }`,
          principal_id: principal,
          scope: assignment.scope,
        });
      } else {
        addResource(doc, 'azurerm_role_assignment', assignment.label, {
          scope: assignment.scope,
          role_definition_name: assignment.role,
          principal_id: principal,
        });
      }
    }

    // Event Grid subscriptions: the subscription lives in THIS domain's
    // terraform, scoped to the (possibly remote) topic by deterministic name.
    component.config.subscriptions.forEach((subscription, index) => {
      const resolved = resolveBinding(model, domain, subscription.bus);
      if (!resolved) {
        throw new ForgeError(`Cannot resolve event bus reference "${subscription.bus}"`);
      }
      const address = busAddress(resolved.domain.name, resolved.component.name);
      addResource(doc, 'azurerm_eventgrid_event_subscription', tfLabel(component.name, `sub${index}`), {
        name: globalName('sub', [model.name, domain.name, component.name, String(index), environment], 64),
        scope: ref(address, 'id'),
        ...(component.type === 'queue-worker'
          ? { service_bus_queue_endpoint_id: ref(queues.get(component.name)!, 'id') }
          : { azure_function_endpoint: { function_id: `${ref(app, 'id')}/functions/${component.name}` } }),
        ...(subscription.pattern.detailType ? { included_event_types: subscription.pattern.detailType } : {}),
        ...(subscription.pattern.source
          ? { advanced_filter: { string_in: [{ key: 'subject', values: subscription.pattern.source }] } }
          : {}),
      });
    });

    doc.output[`${tfLabel(component.name)}_function_app`] = { value: ref(app, 'name') };
  }

  for (const [name, address] of eventBuses) {
    doc.output[`${tfLabel(name)}_topic_endpoint`] = { value: ref(address, 'endpoint') };
  }

  applyWorkspaceTags(doc, model, ctx.domain, environment);
  applyExtension({ document: doc, model, domain: ctx.domain, environment });
  return doc;
}

/**
 * azurerm resource kinds forge creates that accept tags — role assignments,
 * containers, queues/topics and subscriptions do NOT, so tagging is a
 * whitelist, never a blanket.
 */
const TAGGABLE_TF_TYPES = new Set([
  'azurerm_resource_group',
  'azurerm_storage_account',
  'azurerm_cosmosdb_account',
  'azurerm_servicebus_namespace',
  'azurerm_service_plan',
  'azurerm_linux_function_app',
  'azurerm_eventgrid_topic',
]);

/** forge.json "tags" on every taggable resource; forge's own tags win on conflict. */
function applyWorkspaceTags(
  doc: TfDocument,
  model: WorkspaceModel,
  domain: DomainSpec,
  environment: string,
): void {
  const rendered = renderTags(model.tags, {
    project: model.name,
    module: domain.name,
    env: environment,
  });
  if (Object.keys(rendered).length === 0) return;
  const resources = doc.resource as Record<string, Record<string, Record<string, unknown>>>;
  for (const [type, instances] of Object.entries(resources)) {
    if (!TAGGABLE_TF_TYPES.has(type)) continue;
    for (const instance of Object.values(instances)) {
      instance.tags = { ...rendered, ...(instance.tags as Record<string, string> | undefined) };
    }
  }
}
