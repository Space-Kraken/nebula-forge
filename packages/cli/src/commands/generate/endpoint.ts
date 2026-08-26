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

  static args = {
    name: Args.string({ description: 'endpoint name (kebab-case), e.g. get-order', required: true }),
  };

  static flags = {
    module: Flags.string({ char: 'm', description: 'module that owns the API', required: true }),
    method: Flags.string({ description: 'HTTP method', options: [...ENDPOINT_METHODS] }),
    route: Flags.string({ description: 'API route, e.g. /orders/{id}' }),
    api: Flags.string({
      description: 'http-api component that owns the endpoint (inferred when the module has exactly one)',
    }),
    'no-interactive': Flags.boolean({ description: 'never prompt; use flags only' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GenerateEndpoint);
    const model = loadWorkspace(process.cwd());
    const domain = model.domains.find((candidate) => candidate.name === flags.module);
    if (!domain) {
      throw new ForgeError(
        `Unknown module "${flags.module}"`,
        `Available modules: ${model.domains.map((d) => d.name).join(', ') || '(none)'}`,
      );
    }

    const apis = domain.components.filter((component) => component.type === 'http-api');
    const interactive = canPrompt(flags['no-interactive']);

    let apiName = flags.api;
    if (!apiName) {
      if (apis.length === 1) {
        apiName = apis[0].name;
      } else if (apis.length === 0) {
        throw new ForgeError(
          `Module "${flags.module}" has no http-api component`,
          `Create the module's API Lambda first: forge generate component api --module ${flags.module} --type http-api`,
        );
      } else if (interactive) {
        apiName = await promptSelect(
          'Which API owns the endpoint?',
          apis.map((api) => ({ name: api.name, value: api.name })),
        );
      } else {
        throw new ForgeError(
          `Module "${flags.module}" has several http-api components (${apis.map((a) => a.name).join(', ')})`,
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
      route = await promptInput('Route:', `/${args.name}`);
    }

    addEndpoint(model.root, flags.module, apiName, { name: args.name, method, route });
    writeArchitectureDocs(model.root);

    this.log(`✔ Attached ${method} ${route} to ${flags.module}/${apiName}`);
    this.log(`✔ Created controller, use case and test for "${args.name}"`);
    this.log('✔ Updated docs/architecture.md');
    this.log('');
    this.log('Implement the business logic in:');
    this.log(`  domains/${flags.module}/components/${apiName}/src/application/${args.name}.uc.ts`);
    this.log('');
    this.log('Then verify (--update accepts the intentional infra snapshot change):');
    this.log(`  forge test ${flags.module} --update`);
  }
}
