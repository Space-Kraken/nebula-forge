import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { componentManifestSchema } from '@forgecli/core';
import type { ComponentSpec, WorkspaceModel } from '@forgecli/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src';

const fixturesDir = path.join(__dirname, 'fixtures');
const outdirs: string[] = [];

function outdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-synth-'));
  outdirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of outdirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function component(raw: Record<string, unknown>): ComponentSpec {
  return { ...componentManifestSchema.parse(raw), path: fixturesDir } as ComponentSpec;
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
    root: fixturesDir,
    domains: [
      {
        name: 'processing',
        path: fixturesDir,
        components: [
          component({ name: 'data', type: 'table', config: { partitionKey: { name: 'id' } } }),
          component({
            name: 'jobs',
            type: 'queue-worker',
            config: { entry: 'handler.ts' },
            bindings: [{ component: 'data', access: 'read-write' }],
          }),
          component({
            name: 'intake',
            type: 'http-api',
            config: { entry: 'handler.ts' },
            bindings: [{ component: 'jobs', access: 'publish' }],
          }),
        ],
      },
      { name: 'reporting', path: fixturesDir, components: [] },
    ],
  };
}

describe('createApp', () => {
  it('synthesizes one stack per domain with well-architected defaults', () => {
    const { stacks } = createApp(makeModel(), { environment: 'dev', outdir: outdir() });
    expect([...stacks.keys()]).toEqual(['processing', 'reporting']);

    const template = Template.fromStack(stacks.get('processing')!);

    // queue-worker: main queue + dead-letter queue, retries flow to the DLQ
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 4 }),
    });

    // table: on-demand billing, deletable outside production
    template.hasResourceProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });

    // REST API (payload v1, as fusion-server expects) in front of the intake lambda
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);

    // bindings inject discovery env vars into the consumers
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: { Variables: Match.objectLike({ TABLE_DATA_NAME: Match.anyValue() }) },
      }),
    );
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: { Variables: Match.objectLike({ QUEUE_JOBS_URL: Match.anyValue() }) },
      }),
    );
  });

  it('retains stateful resources in production environments', () => {
    const { stacks } = createApp(makeModel(), { environment: 'prod', outdir: outdir() });
    const template = Template.fromStack(stacks.get('processing')!);
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });

  it('can synthesize a subset of domains', () => {
    const { stacks } = createApp(makeModel(), {
      environment: 'dev',
      outdir: outdir(),
      domains: ['reporting'],
    });
    expect([...stacks.keys()]).toEqual(['reporting']);
  });

  it('rejects unknown environments', () => {
    expect(() => createApp(makeModel(), { environment: 'staging', outdir: outdir() })).toThrow(
      /Environment "staging" is not declared/,
    );
  });

  it('rejects unknown domains', () => {
    expect(() =>
      createApp(makeModel(), { environment: 'dev', outdir: outdir(), domains: ['nope'] }),
    ).toThrow(/Unknown domain "nope"/);
  });
});

function makeEventModel(): WorkspaceModel {
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
        components: [component({ name: 'events', type: 'event-bus' })],
      },
      {
        name: 'orders',
        path: fixturesDir,
        components: [
          component({
            name: 'api',
            type: 'http-api',
            config: { entry: 'handler.ts' },
            bindings: [{ component: 'platform/events', access: 'publish' }],
          }),
        ],
      },
      {
        name: 'billing',
        path: fixturesDir,
        components: [
          component({
            name: 'processor',
            type: 'queue-worker',
            config: {
              entry: 'handler.ts',
              subscriptions: [{ bus: 'platform/events', pattern: { source: ['orders'] } }],
            },
          }),
        ],
      },
    ],
  };
}

describe('event-driven wiring', () => {
  it('creates the bus with its deterministic name', () => {
    const { stacks } = createApp(makeEventModel(), { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);
    template.hasResourceProperties('AWS::Events::EventBus', { Name: 'shop-platform-events-dev' });
  });

  it('grants cross-domain publishers PutEvents by bus name, without stack exports', () => {
    const { stacks } = createApp(makeEventModel(), { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('orders')!);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'events:PutEvents', Effect: 'Allow' }),
        ]),
      }),
    });
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: {
          Variables: Match.objectLike({ BUS_PLATFORM_EVENTS_NAME: 'shop-platform-events-dev' }),
        },
      }),
    );
    // decoupling invariant: no CloudFormation exports between domains
    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
  });

  it('subscribes queue workers to the bus from their own stack', () => {
    const { stacks } = createApp(makeEventModel(), { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('billing')!);

    template.hasResourceProperties('AWS::Events::Rule', {
      EventBusName: 'shop-platform-events-dev',
      EventPattern: { source: ['orders'] },
    });
    template.resourceCountIs('AWS::SQS::QueuePolicy', 1);
  });

  it('delivers function subscriptions straight to the Lambda', () => {
    const model: WorkspaceModel = {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'us-east-1' } },
      root: fixturesDir,
      domains: [
        {
          name: 'alerts',
          path: fixturesDir,
          components: [
            component({ name: 'bus', type: 'event-bus' }),
            component({
              name: 'notifier',
              type: 'function',
              config: { entry: 'handler.ts', subscriptions: [{ bus: 'bus', pattern: { detailType: ['Alert'] } }] },
            }),
          ],
        },
      ],
    };
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('alerts')!);

    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { 'detail-type': ['Alert'] },
      Targets: Match.arrayWith([
        Match.objectLike({ Arn: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('NotifierFunction')]) }) }),
      ]),
    });
    // EventBridge needs permission to invoke the function
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'events.amazonaws.com',
    });
  });

  it('references same-stack buses as constructs so CloudFormation orders creation', () => {
    const model: WorkspaceModel = {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'us-east-1' } },
      root: fixturesDir,
      domains: [
        {
          name: 'events',
          path: fixturesDir,
          components: [
            component({ name: 'bus', type: 'event-bus' }),
            component({
              name: 'worker',
              type: 'queue-worker',
              config: { entry: 'handler.ts', subscriptions: [{ bus: 'bus', pattern: { source: ['events'] } }] },
            }),
          ],
        },
      ],
    };
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('events')!);

    // EventBusName must be a Ref to the bus resource, not a literal string
    template.hasResourceProperties('AWS::Events::Rule', {
      EventBusName: Match.objectLike({ Ref: Match.stringLikeRegexp('BusEventBus') }),
    });
  });
});

describe('email identities', () => {
  it('provisions the SES identity and grants send to bound functions', () => {
    const model: WorkspaceModel = {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'us-east-1' } },
      root: fixturesDir,
      domains: [
        {
          name: 'billing',
          path: fixturesDir,
          components: [
            component({ name: 'notifications', type: 'email', config: { identity: 'no-reply@app.com' } }),
            component({
              name: 'mailer',
              type: 'function',
              config: { entry: 'handler.ts' },
              bindings: [{ component: 'notifications', access: 'send' }],
            }),
          ],
        },
      ],
    };
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('billing')!);

    template.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'no-reply@app.com' });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['ses:SendEmail']) }),
        ]),
      }),
    });
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: { Variables: Match.objectLike({ EMAIL_NOTIFICATIONS_FROM: 'no-reply@app.com' }) },
      }),
    );
  });
});

describe('edge: api behind the distribution, cors, custom domains', () => {
  function edgeModel(components: ComponentSpec[]): WorkspaceModel {
    return {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: {
        dev: { region: 'us-east-1' },
        prod: { region: 'eu-west-1', production: true },
      },
      root: fixturesDir,
      domains: [{ name: 'platform', path: fixturesDir, components }],
    };
  }

  it('serves a same-module api behind CloudFront at /api/* with a prefix-stripping function', () => {
    const model = edgeModel([
      component({ name: 'web', type: 'static-site', config: { api: 'api' } }),
      component({ name: 'api', type: 'http-api', config: { entry: 'handler.ts' } }),
    ]);
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);

    // /api rewrite + SPA fallback (spa mode moves off CustomErrorResponses
    // when an extra origin exists, so API errors stay honest)
    template.resourceCountIs('AWS::CloudFront::Function', 2);
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/api/*',
              AllowedMethods: Match.arrayWith(['POST', 'DELETE']),
              OriginRequestPolicyId: Match.anyValue(),
              FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
            }),
          ]),
          Origins: Match.arrayWith([
            Match.objectLike({ OriginPath: '/dev', DomainName: Match.objectLike({ 'Fn::Join': Match.anyValue() }) }),
          ]),
        }),
      }),
    );
  });

  it('serves a same-module bucket at /media/* and switches the SPA fallback to a function', () => {
    const model = edgeModel([
      component({ name: 'web', type: 'static-site', config: { media: 'uploads' } }),
      component({ name: 'uploads', type: 'bucket' }),
    ]);
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);

    // media rewrite + SPA fallback rewrite
    template.resourceCountIs('AWS::CloudFront::Function', 2);
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/media/*',
              AllowedMethods: ['GET', 'HEAD'],
              FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
            }),
          ]),
          // the SPA fallback moved to the default behavior's function…
          DefaultCacheBehavior: Match.objectLike({
            FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
          }),
        }),
      }),
    );
    // …so distribution-wide error rewrites (which would mask media 404s as
    // 200 index.html) are gone
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const config = Object.values(distributions)[0].Properties.DistributionConfig;
    expect(config.CustomErrorResponses).toBeUndefined();
  });

  it('adds a custom domain to a static-site: DNS-validated cert, aliases, A/AAAA records', () => {
    const model = edgeModel([
      component({
        name: 'web',
        type: 'static-site',
        config: { domain: { name: 'portfolio.example.com', zone: { id: 'Z0123456789', name: 'example.com' } } },
      }),
    ]);
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);

    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'portfolio.example.com',
      ValidationMethod: 'DNS',
    });
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({ Aliases: ['portfolio.example.com'] }),
      }),
    );
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'portfolio.example.com.',
      Type: 'A',
      HostedZoneId: 'Z0123456789',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'AAAA' });
  });

  it('rejects a CloudFront custom domain outside us-east-1 and honors domain.environments', () => {
    const restricted = edgeModel([
      component({
        name: 'web',
        type: 'static-site',
        config: {
          domain: {
            name: 'portfolio.example.com',
            zone: { id: 'Z0123456789', name: 'example.com' },
            environments: ['dev'],
          },
        },
      }),
    ]);
    // prod is eu-west-1, but the domain is dev-only → no cert, no error
    const { stacks } = createApp(restricted, { environment: 'prod', outdir: outdir() });
    Template.fromStack(stacks.get('platform')!).resourceCountIs('AWS::CertificateManager::Certificate', 0);

    const unrestricted = edgeModel([
      component({
        name: 'web',
        type: 'static-site',
        config: { domain: { name: 'portfolio.example.com', zone: { id: 'Z0123456789', name: 'example.com' } } },
      }),
    ]);
    expect(() => createApp(unrestricted, { environment: 'prod', outdir: outdir() })).toThrow(/us-east-1/);
  });

  it('gives a gateway a regional custom domain with base path mapping and alias record', () => {
    const model = edgeModel([
      component({
        name: 'edge',
        type: 'gateway',
        config: { domain: { name: 'api.example.com', zone: { id: 'Z0123456789', name: 'example.com' } } },
      }),
    ]);
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);

    template.hasResourceProperties('AWS::ApiGateway::DomainName', {
      DomainName: 'api.example.com',
      EndpointConfiguration: { Types: ['REGIONAL'] },
      SecurityPolicy: 'TLS_1_2',
    });
    template.resourceCountIs('AWS::ApiGateway::BasePathMapping', 1);
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'api.example.com.', Type: 'A' });
  });

  it('cors on an http-api: gateway-answered preflight plus CORS_ORIGIN on the lambda', () => {
    const model = edgeModel([
      component({
        name: 'api',
        type: 'http-api',
        config: { entry: 'handler.ts', cors: { origins: ['https://app.example.com'] } },
      }),
    ]);
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);

    template.hasResourceProperties(
      'AWS::ApiGateway::Method',
      Match.objectLike({
        HttpMethod: 'OPTIONS',
        Integration: Match.objectLike({
          IntegrationResponses: Match.arrayWith([
            Match.objectLike({
              ResponseParameters: Match.objectLike({
                'method.response.header.Access-Control-Allow-Origin': "'https://app.example.com'",
              }),
            }),
          ]),
        }),
      }),
    );
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: { Variables: Match.objectLike({ CORS_ORIGIN: 'https://app.example.com' }) },
      }),
    );
  });

  it('a mounted api inherits the gateway cors as CORS_ORIGIN in its own stack', () => {
    const model: WorkspaceModel = {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'us-east-1' } },
      root: fixturesDir,
      domains: [
        {
          name: 'platform',
          path: fixturesDir,
          components: [component({ name: 'edge', type: 'gateway', config: { cors: true } })],
        },
        {
          name: 'users',
          path: fixturesDir,
          components: [
            component({ name: 'api', type: 'http-api', config: { entry: 'handler.ts', mount: 'platform/edge' } }),
          ],
        },
      ],
    };
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    Template.fromStack(stacks.get('users')!).hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: { Variables: Match.objectLike({ CORS_ORIGIN: '*' }) },
      }),
    );
  });
});

describe('packs and the escape hatch', () => {
  it('builds pack components through their registered aws builder, bindings included', async () => {
    const { registerPack, resetPacks } = await import('@forgecli/core');
    const { Bucket } = await import('aws-cdk-lib/aws-s3');
    resetPacks();
    registerPack({
      name: 'test-pack',
      components: [
        {
          type: 'secret',
          configSchema: { safeParse: (v: unknown) => ({ success: true, data: v ?? {} }) } as never,
          bindable: { access: ['read'], envVar: { prefix: 'SECRET', suffix: 'ARN' } },
          engines: {
            'aws-cdk': (scope: never, spec: { name: string }) => {
              const bucket = new Bucket(scope, 'PackResource');
              return {
                resource: bucket,
                grant: (grantee: never) => bucket.grantRead(grantee),
                bindingEnv: { SECRET_VAULT_ARN: 'arn:test:vault' },
              };
            },
          },
        },
      ],
    });

    const model: WorkspaceModel = {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'us-east-1' } },
      root: fixturesDir,
      domains: [
        {
          name: 'billing',
          path: fixturesDir,
          components: [
            component({
              name: 'mailer',
              type: 'function',
              config: { entry: 'handler.ts' },
              bindings: [{ component: 'vault', access: 'read' }],
            }),
          ],
          packComponents: [
            { name: 'vault', type: 'secret', bindings: [], config: {}, path: fixturesDir, pack: 'test-pack' },
          ],
        },
      ],
    };
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('billing')!);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: { Variables: Match.objectLike({ SECRET_VAULT_ARN: 'arn:test:vault' }) },
      }),
    );
    resetPacks();
  });

  it('runs domains/<module>/extend.ts inside the domain stack', () => {
    const extendedDir = path.join(fixturesDir, 'extended');
    const model: WorkspaceModel = {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'us-east-1' } },
      root: fixturesDir,
      domains: [
        {
          name: 'billing',
          path: extendedDir,
          components: [
            component({ name: 'mailer', type: 'function', config: { entry: 'handler.ts' } }),
          ],
        },
      ],
    };
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('billing')!);
    template.hasOutput('ExtendedOutput', { Value: 'from-extend-dev' });
  });
});

describe('shared gateway', () => {
  function gatewayModel(): WorkspaceModel {
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
          components: [component({ name: 'edge', type: 'gateway' })],
        },
        {
          name: 'users',
          path: fixturesDir,
          components: [
            component({
              name: 'api',
              type: 'http-api',
              config: { entry: 'handler.ts', mount: 'platform/edge', routes: [{ method: 'GET', path: '/users/{id}' }] },
            }),
          ],
        },
        {
          name: 'orders',
          path: fixturesDir,
          components: [
            component({
              name: 'api',
              type: 'http-api',
              config: { entry: 'handler.ts', mount: 'platform/edge', routes: [{ method: 'POST', path: '/orders' }] },
            }),
          ],
        },
      ],
    };
  }

  it('publishes the union of mounted routes, integrating lambdas by deterministic ARN', () => {
    const { stacks } = createApp(gatewayModel(), { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);

    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{id}' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'orders' });

    // one explicit invoke permission per mounted lambda, by constructed ARN
    template.resourceCountIs('AWS::Lambda::Permission', 2);
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'apigateway.amazonaws.com',
      FunctionName: Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([Match.stringLikeRegexp(':function:shop-users-api-dev')]),
        ]),
      }),
    });

    // decoupling invariant: no CloudFormation exports between domains
    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
  });

  it('mounted http-apis ship only their lambda; unmounted keep their own gateway', () => {
    const { stacks } = createApp(gatewayModel(), { environment: 'dev', outdir: outdir() });
    const users = Template.fromStack(stacks.get('users')!);
    users.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    users.resourceCountIs('AWS::Lambda::Function', 1);
  });

  it('protects mounted routes with the gateway auth, honoring public routes', () => {
    const model = gatewayModel();
    model.domains[0].components.push(component({ name: 'identity', type: 'auth' }));
    model.domains[0].components[0] = component({ name: 'edge', type: 'gateway', config: { auth: 'identity' } });
    model.domains[1].components[0] = component({
      name: 'api',
      type: 'http-api',
      config: {
        entry: 'handler.ts',
        mount: 'platform/edge',
        routes: [
          { method: 'GET', path: '/users/{id}' },
          { method: 'GET', path: '/users/status', public: true },
        ],
      },
    });
    model.domains = [model.domains[0], model.domains[1]];

    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);

    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', { Type: 'COGNITO_USER_POOLS' });
    // one protected method (/users/{id}) and one public (/users/status)
    template.resourcePropertiesCountIs('AWS::ApiGateway::Method', { AuthorizationType: 'COGNITO_USER_POOLS' }, 1);
    template.resourcePropertiesCountIs('AWS::ApiGateway::Method', { AuthorizationType: 'NONE' }, 1);
  });

  it('a gateway with auth whose mounted routes are all public synthesizes without an authorizer', () => {
    // Regression: CDK refuses an authorizer no method references, so the
    // authorizer must be lazy — the day-one scaffold (auth + gateway + only
    // public /status routes) must still synth.
    const model = gatewayModel();
    model.domains[0].components.push(component({ name: 'identity', type: 'auth' }));
    model.domains[0].components[0] = component({ name: 'edge', type: 'gateway', config: { auth: 'identity' } });
    model.domains[1].components[0] = component({
      name: 'api',
      type: 'http-api',
      config: {
        entry: 'handler.ts',
        mount: 'platform/edge',
        routes: [{ method: 'GET', path: '/users/status', public: true }],
      },
    });
    model.domains = [model.domains[0], model.domains[1]];

    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);

    template.resourceCountIs('AWS::ApiGateway::Authorizer', 0);
    template.resourcePropertiesCountIs('AWS::ApiGateway::Method', { AuthorizationType: 'NONE' }, 1);
  });

  it('an empty gateway still deploys with a 404 placeholder', () => {
    const model = gatewayModel();
    model.domains = [model.domains[0]];
    const { stacks } = createApp(model, { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('platform')!);
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      Integration: Match.objectLike({ Type: 'MOCK' }),
    });
  });
});

describe('static sites', () => {
  function siteModel(config: Record<string, unknown> = {}, region = 'us-east-1'): WorkspaceModel {
    return {
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region } },
      root: fixturesDir,
      domains: [
        {
          name: 'web',
          path: fixturesDir,
          components: [component({ name: 'site', type: 'static-site', config })],
        },
      ],
    };
  }

  it('serves a private bucket through CloudFront with SPA fallbacks', () => {
    const { stacks } = createApp(siteModel(), { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('web')!);

    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', Match.anyValue());
    // site/ fixture exists → assets are deployed
    template.resourceCountIs('Custom::CDKBucketDeployment', 1);
  });

  it('puts a WAF in front when requested in us-east-1', () => {
    const { stacks } = createApp(siteModel({ waf: true }), { environment: 'dev', outdir: outdir() });
    const template = Template.fromStack(stacks.get('web')!);
    template.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'CLOUDFRONT' });
  });

  it('rejects WAF outside us-east-1 with a clear error', () => {
    expect(() =>
      createApp(siteModel({ waf: true }, 'eu-west-1'), { environment: 'dev', outdir: outdir() }),
    ).toThrow(/us-east-1/);
  });
});
