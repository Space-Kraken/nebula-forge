import { Args, Flags } from '@oclif/core';
import { ForgeError, loadWorkspace } from '@forgecli/core';
import { BaseCommand } from '../../lib/base';
import { writeArchitectureDocs } from '../../lib/docs';
import { addEndpoint, ENDPOINT_METHODS } from '../../lib/endpoints';
import type { EndpointMethod } from '../../lib/endpoints';
import { canPrompt, promptInput, promptSelect } from '../../lib/interactive';

export default class GenerateEndpoint extends BaseCommand {
  static description =
    'Attach an endpoint to a module’s API Lambda: API Gateway route + fusion controller + use case + test, kept in sync automatically';

  static examples = [
    'forge generate endpoint get-order --module orders --method GET --route /orders/{id}',
    'forge generate endpoint create-order --module orders --method POST --route /orders',
  ];

  static aliases = ['g:endpoint', 'g:e', 'ge'];

  static args = {
    name: Args.string({ description: 'endpoint name (kebab-case), e.g. get-order; prompted when omitted' }),
  };

  static flags = {
    module: Flags.string({ char: 'm', description: 'module that owns the API (prompted when omitted)' }),
    method: Flags.string({ description: 'HTTP method', options: [...ENDPOINT_METHODS] }),
    route: Flags.string({ description: 'API route, e.g. /orders/{id}' }),
    api: Flags.string({
      description: 'http-api component that owns the endpoint (inferred when the module has exactly one)',
    }),
    public: Flags.boolean({
      description: 'skip the API’s authorizer for this endpoint (health checks, webhooks)',
    }),
    'no-interactive': Flags.boolean({ description: 'never prompt; use flags only' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GenerateEndpoint);
    const model = this.loadModel();
    const interactive = canPrompt(flags['no-interactive']);

    let epName = args.name;
    if (!epName) {
      if (!interactive) throw new ForgeError('Missing endpoint name', 'Usage: forge generate endpoint <name> …');
      epName = (await promptInput('Endpoint name (kebab-case, e.g. get-order):')).trim();
    }
    let epModule = flags.module;
    if (!epModule) {
      if (!interactive || model.domains.length === 0) {
        throw new ForgeError(
          'Missing --module',
          `Available modules: ${model.domains.map((d) => d.name).join(', ') || '(none)'}`,
        );
      }
      epModule =
        model.domains.length === 1
          ? model.domains[0].name
          : await promptSelect(
              'Which module owns the endpoint?',
              model.domains.map((d) => ({ name: d.name, value: d.name })),
            );
    }
    const domain = model.domains.find((candidate) => candidate.name === epModule);
    if (!domain) {
      throw new ForgeError(
        `Unknown module "${epModule}"`,
        `Available modules: ${model.domains.map((d) => d.name).join(', ') || '(none)'}`,
      );
    }

    const apis = domain.components.filter((component) => component.type === 'http-api');

    let apiName = flags.api;
    if (!apiName) {
      if (apis.length === 1) {
        apiName = apis[0].name;
      } else if (apis.length === 0) {
        throw new ForgeError(
          `Module "${epModule}" has no http-api component`,
          `Create the module's API Lambda first: forge generate component api --module ${epModule} --type http-api`,
        );
      } else if (interactive) {
        apiName = await promptSelect(
          'Which API owns the endpoint?',
          apis.map((api) => ({ name: api.name, value: api.name })),
        );
      } else {
        throw new ForgeError(
          `Module "${epModule}" has several http-api components (${apis.map((a) => a.name).join(', ')})`,
          'Pick one with --api.',
        );
      }
    }

    let method = flags.method as EndpointMethod | undefined;
    if (!method) {
      if (!interactive) throw new ForgeError('Missing --method', `Allowed: ${ENDPOINT_METHODS.join(', ')}`);
      method = await promptSelect<EndpointMethod>(
        'HTTP method:',
        ENDPOINT_METHODS.map((value) => ({ name: value, value })),
        'GET',
      );
    }

    let route = flags.route;
    if (!route) {
      if (!interactive) throw new ForgeError('Missing --route', 'Example: --route /orders/{id}');
      route = await promptInput('Route:', `/${epName}`);
    }

    addEndpoint(model.root, epModule, apiName, { name: epName, method, route, public: flags.public });
    writeArchitectureDocs(model.root);

    this.log(`✔ Attached ${method} ${route} to ${epModule}/${apiName}`);
    const api = domain.components.find((component) => component.name === apiName);
    if (api?.type === 'http-api' && api.config.mount) {
      this.log(
        `ℹ Route topology changed on gateway ${api.config.mount} — deploy "${epModule}" AND the gateway's module.`,
      );
    }
    this.log(`✔ Created controller, use case and test for "${epName}"`);
    this.log('✔ Updated docs/architecture.md');
    this.log('');
    this.log('Implement the business logic in:');
    this.log(`  domains/${epModule}/components/${apiName}/src/application/${epName}.uc.ts`);
    this.log('');
    this.log('Then verify (--update accepts the intentional infra snapshot change):');
    this.log(`  forge test ${epModule} --update`);
  }
}
