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
