import * as fs from 'node:fs';
import * as path from 'node:path';
import { Aws, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { EventBus, Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import { Architecture, CfnPermission, Function as LambdaFunction, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { bindingEnvVarFor, ForgeError, resolveBinding, resourceNameFor, toConstructId } from '@forgecli/core';
import type { ComponentSpec, DomainSpec, WorkspaceModel } from '@forgecli/core';
import type { Construct } from 'constructs';
import type { BuiltComponent } from './types';

export interface BuildContext {
  model: WorkspaceModel;
  domain: DomainSpec;
  environment: string;
  production: boolean;
}

interface FunctionBaseConfig {
  entry: string;
  memoryMb: number;
  timeoutSeconds: number;
  environment: Record<string, string>;
}

/** Deterministic physical name, omitted when it would exceed the service limit. */
function physicalName(ctx: BuildContext, componentName: string, maxLength: number): string | undefined {
  const name = resourceNameFor(ctx.model.name, ctx.domain.name, componentName, ctx.environment);
  return name.length <= maxLength ? name : undefined;
}


function statefulRemovalPolicy(ctx: BuildContext): RemovalPolicy {
  return ctx.production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}

function addRestRoutes(
  api: apigateway.RestApi,
  routes: { method: string; path: string }[],
  integration: apigateway.Integration,
): void {
  for (const route of routes) {
    const resource = route.path === '/' ? api.root : api.root.resourceForPath(route.path);
    resource.addMethod(route.method, integration);
  }
}

function createFunction(
  scope: Construct,
  id: string,
  spec: ComponentSpec,
  config: FunctionBaseConfig,
  ctx: BuildContext,
): NodejsFunction {
  return new NodejsFunction(scope, id, {
    functionName: physicalName(ctx, spec.name, 64),
    entry: path.join(spec.path, config.entry),
    handler: 'handler',
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    memorySize: config.memoryMb,
    timeout: Duration.seconds(config.timeoutSeconds),
    environment: config.environment,
    tracing: Tracing.ACTIVE,
    bundling: { minify: true, sourceMap: true, target: 'node24' },
  });
}

const ATTRIBUTE_TYPES: Record<'string' | 'number' | 'binary', dynamodb.AttributeType> = {
  string: dynamodb.AttributeType.STRING,
  number: dynamodb.AttributeType.NUMBER,
  binary: dynamodb.AttributeType.BINARY,
};

export function buildComponent(scope: Construct, spec: ComponentSpec, ctx: BuildContext): BuiltComponent {
  const id = toConstructId(spec.name);

  switch (spec.type) {
    case 'function': {
      const fn = createFunction(scope, `${id}Function`, spec, spec.config, ctx);
      if (spec.config.schedule) {
        new Rule(scope, `${id}Schedule`, {
          schedule: Schedule.expression(spec.config.schedule),
          targets: [new LambdaFunctionTarget(fn)],
        });
      }
      return { spec, resource: fn, lambda: fn };
    }

    case 'http-api': {
      const fn = createFunction(scope, `${id}Function`, spec, spec.config, ctx);
      if (spec.config.mount) {
        // Mounted on a shared gateway: that gateway publishes the routes and
        // integrates this Lambda by deterministic name — this domain ships
        // only its code.
        return { spec, resource: fn, lambda: fn };
      }
      // REST API (payload v1) with one explicit resource per route: fusion-server
      // routes by exact `httpMethod + resource` match, so the API definition and
      // the controller decorators must mirror each other.
      const api = new apigateway.RestApi(scope, `${id}RestApi`, {
        restApiName: physicalName(ctx, spec.name, 128),
        cloudWatchRole: false,
        deployOptions: { stageName: ctx.environment, tracingEnabled: true },
      });
      addRestRoutes(api, spec.config.routes, new apigateway.LambdaIntegration(fn));
      new CfnOutput(scope, `${id}Url`, {
        value: api.url,
        description: `Base URL of the ${spec.name} API`,
      });
      return { spec, resource: api, lambda: fn };
    }

    case 'gateway': {
      // The shared front door: one REST API publishing the union of routes of
      // every http-api mounted on it, across domains. Lambdas are integrated
      // by deterministic ARN (pseudo-parameters resolve account/region at
      // deploy), so no CloudFormation exports couple the stacks.
      const api = new apigateway.RestApi(scope, `${id}RestApi`, {
        restApiName: physicalName(ctx, spec.name, 128),
        cloudWatchRole: false,
        deployOptions: { stageName: ctx.environment, tracingEnabled: true },
      });
      let mounted = 0;
      for (const domain of ctx.model.domains) {
        for (const component of domain.components) {
          if (component.type !== 'http-api' || !component.config.mount) continue;
          const resolved = resolveBinding(ctx.model, domain, component.config.mount);
          if (resolved?.domain.name !== ctx.domain.name || resolved.component.name !== spec.name) continue;

          const functionArn = `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:function:${resourceNameFor(ctx.model.name, domain.name, component.name, ctx.environment)}`;
          const importId = `${id}${toConstructId(domain.name)}${toConstructId(component.name)}`;
          const target = LambdaFunction.fromFunctionArn(scope, `${importId}Fn`, functionArn);
          addRestRoutes(api, component.config.routes, new apigateway.LambdaIntegration(target));
          new CfnPermission(scope, `${importId}Permission`, {
            action: 'lambda:InvokeFunction',
            functionName: functionArn,
            principal: 'apigateway.amazonaws.com',
            sourceArn: api.arnForExecuteApi(),
          });
          mounted += 1;
        }
      }
      if (mounted === 0) {
        // A REST API without methods cannot deploy — placeholder until the
        // first http-api mounts.
        api.root.addMethod(
          'GET',
          new apigateway.MockIntegration({
            requestTemplates: { 'application/json': '{"statusCode": 404}' },
            integrationResponses: [
              {
                statusCode: '404',
                responseTemplates: { 'application/json': '{"message":"no APIs mounted on this gateway yet"}' },
              },
            ],
          }),
          { methodResponses: [{ statusCode: '404' }] },
        );
      }
      new CfnOutput(scope, `${id}Url`, {
        value: api.url,
        description: `Base URL of the ${spec.name} gateway`,
      });
      return { spec, resource: api };
    }

    case 'queue-worker': {
      const fifo = spec.config.fifo || undefined;
      const deadLetterQueue = new Queue(scope, `${id}Dlq`, {
        fifo,
        retentionPeriod: Duration.days(14),
      });
      const queue = new Queue(scope, `${id}Queue`, {
        fifo,
        contentBasedDeduplication: fifo,
        // SQS best practice: visibility timeout of at least 6x the consumer timeout.
        visibilityTimeout: Duration.seconds(Math.max(30, spec.config.timeoutSeconds * 6)),
        deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: spec.config.maxRetries + 1 },
      });
      const fn = createFunction(scope, `${id}Function`, spec, spec.config, ctx);
      fn.addEventSource(
        new SqsEventSource(queue, { batchSize: spec.config.batchSize, reportBatchItemFailures: true }),
      );
      // Subscriptions are wired in a second pass (applySubscriptions) so
      // same-stack buses can be referenced as constructs.
      return {
        spec,
        resource: queue,
        lambda: fn,
        queue,
        grant: (grantee) => queue.grantSendMessages(grantee),
        bindingEnv: { [bindingEnvVarFor(spec.type, spec.name)!]: queue.queueUrl },
      };
    }

    case 'table': {
      const table = new dynamodb.Table(scope, `${id}Table`, {
        tableName: physicalName(ctx, spec.name, 255),
        partitionKey: {
          name: spec.config.partitionKey.name,
          type: ATTRIBUTE_TYPES[spec.config.partitionKey.type],
        },
        sortKey: spec.config.sortKey
          ? { name: spec.config.sortKey.name, type: ATTRIBUTE_TYPES[spec.config.sortKey.type] }
          : undefined,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        timeToLiveAttribute: spec.config.timeToLiveAttribute,
        removalPolicy: statefulRemovalPolicy(ctx),
      });
      return {
        spec,
        resource: table,
        grant: (grantee, access) => {
          if (access === 'read') table.grantReadData(grantee);
          else if (access === 'write') table.grantWriteData(grantee);
          else table.grantReadWriteData(grantee);
        },
        bindingEnv: { [bindingEnvVarFor(spec.type, spec.name)!]: table.tableName },
      };
    }

    case 'bucket': {
      const bucket = new Bucket(scope, `${id}Bucket`, {
        encryption: BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        versioned: spec.config.versioned,
        removalPolicy: statefulRemovalPolicy(ctx),
      });
      return {
        spec,
        resource: bucket,
        grant: (grantee, access) => {
          if (access === 'read') bucket.grantRead(grantee);
          else if (access === 'write') bucket.grantWrite(grantee);
          else bucket.grantReadWrite(grantee);
        },
        bindingEnv: { [bindingEnvVarFor(spec.type, spec.name)!]: bucket.bucketName },
      };
    }

    case 'topic': {
      const fifo = spec.config.fifo || undefined;
      const topic = new Topic(scope, `${id}Topic`, {
        fifo,
        contentBasedDeduplication: fifo,
      });
      return {
        spec,
        resource: topic,
        grant: (grantee) => topic.grantPublish(grantee),
        bindingEnv: { [bindingEnvVarFor(spec.type, spec.name)!]: topic.topicArn },
      };
    }

    case 'event-bus': {
      // The name is deterministic on purpose: other domains publish and
      // subscribe to this bus by name, keeping every stack independent.
      const bus = new EventBus(scope, `${id}EventBus`, {
        eventBusName: resourceNameFor(ctx.model.name, ctx.domain.name, spec.name, ctx.environment),
      });
      return {
        spec,
        resource: bus,
        eventBus: bus,
        grant: (grantee) => bus.grantPutEventsTo(grantee),
        bindingEnv: { [bindingEnvVarFor(spec.type, spec.name)!]: bus.eventBusName },
      };
    }

    case 'static-site': {
      const bucket = new Bucket(scope, `${id}SiteBucket`, {
        encryption: BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        removalPolicy: statefulRemovalPolicy(ctx),
        autoDeleteObjects: !ctx.production,
      });

      let webAcl: CfnWebACL | undefined;
      if (spec.config.waf) {
        const region = ctx.model.environments[ctx.environment]?.region;
        if (region !== 'us-east-1') {
          throw new ForgeError(
            `Component "${ctx.domain.name}/${spec.name}": CloudFront WAF requires the stack to live in us-east-1 (environment "${ctx.environment}" is in ${region})`,
            'AWS only accepts CLOUDFRONT-scoped WAF WebACLs created in us-east-1. Use a us-east-1 environment for this domain, or disable waf.',
          );
        }
        webAcl = new CfnWebACL(scope, `${id}WebAcl`, {
          defaultAction: { allow: {} },
          scope: 'CLOUDFRONT',
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${id}Waf`,
            sampledRequestsEnabled: true,
          },
          rules: [
            {
              name: 'AWSManagedRulesCommonRuleSet',
              priority: 0,
              statement: {
                managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
              },
              overrideAction: { none: {} },
              visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${id}CommonRuleSet`,
                sampledRequestsEnabled: true,
              },
            },
          ],
        });
      }

      const distribution = new cloudfront.Distribution(scope, `${id}Distribution`, {
        defaultBehavior: {
          origin: S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        defaultRootObject: 'index.html',
        errorResponses: spec.config.spa
          ? [
              { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
              { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
            ]
          : undefined,
        webAclId: webAcl?.attrArn,
      });

      const sourceDir = path.join(spec.path, spec.config.sourceDir);
      if (!fs.existsSync(sourceDir)) {
        // A silently skipped deployment would ship an empty site where every
        // request 403s — fail loudly instead.
        throw new ForgeError(
          `Component "${ctx.domain.name}/${spec.name}": source directory "${spec.config.sourceDir}" does not exist (${sourceDir})`,
          'Build your frontend into that directory, or point config.sourceDir at your build output, before synthesizing.',
        );
      }
      new BucketDeployment(scope, `${id}Deployment`, {
        sources: [Source.asset(sourceDir)],
        destinationBucket: bucket,
        distribution,
        distributionPaths: ['/*'],
      });

      new CfnOutput(scope, `${id}Url`, {
        value: `https://${distribution.distributionDomainName}`,
        description: `URL of the ${spec.name} site`,
      });
      return { spec, resource: distribution };
    }
  }

  throw new ForgeError(`Unsupported component type "${(spec as ComponentSpec).type}"`);
}
