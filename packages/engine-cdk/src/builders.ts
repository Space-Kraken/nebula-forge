import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, Aws, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayDomain, CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { EventBus, Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import { Architecture, CfnPermission, Function as LambdaFunction, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { EmailIdentity, Identity } from 'aws-cdk-lib/aws-ses';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { bindingEnvVarFor, ForgeError, resolveBinding, resourceNameFor, toConstructId } from '@forgecli/core';
import type { ComponentSpec, CorsConfig, CustomDomainConfig, DomainSpec, WorkspaceModel } from '@forgecli/core';
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
  routes: { method: string; path: string; public?: boolean }[],
  integration: apigateway.Integration,
  authorizer?: apigateway.CognitoUserPoolsAuthorizer,
): void {
  for (const route of routes) {
    const resource = route.path === '/' ? api.root : api.root.resourceForPath(route.path);
    resource.addMethod(
      route.method,
      integration,
      authorizer && !route.public
        ? { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO }
        : undefined,
    );
  }
}

/** Allowed origins for a cors config, or undefined when cors is off. */
function corsOrigins(cors: CorsConfig | undefined): string[] | undefined {
  if (!cors) return undefined;
  return cors === true ? ['*'] : cors.origins;
}

/** Preflight (OPTIONS) handled by API Gateway itself, on every resource. */
function corsPreflight(cors: CorsConfig | undefined): apigateway.CorsOptions | undefined {
  const origins = corsOrigins(cors);
  if (!origins) return undefined;
  return {
    allowOrigins: origins,
    allowMethods: apigateway.Cors.ALL_METHODS,
    allowHeaders: ['content-type', 'authorization', 'x-api-key', 'x-amz-date', 'x-amz-security-token'],
    maxAge: Duration.hours(1),
  };
}

/** The custom domain if it applies to this environment, else undefined. */
function activeDomain(domain: CustomDomainConfig | undefined, ctx: BuildContext): CustomDomainConfig | undefined {
  if (!domain) return undefined;
  return !domain.environments || domain.environments.includes(ctx.environment) ? domain : undefined;
}

/** Hosted zone from the explicit id/name in config — no account lookup at synth. */
function dnsZone(scope: Construct, id: string, domain: CustomDomainConfig): IHostedZone {
  return HostedZone.fromHostedZoneAttributes(scope, `${id}Zone`, {
    hostedZoneId: domain.zone.id,
    zoneName: domain.zone.name,
  });
}

/** Regional custom domain for a REST API: DNS-validated cert + mapping + alias records. */
function attachApiDomain(
  scope: Construct,
  id: string,
  specName: string,
  domainConfig: CustomDomainConfig | undefined,
  api: apigateway.RestApi,
  ctx: BuildContext,
): void {
  const domain = activeDomain(domainConfig, ctx);
  if (!domain) return;
  const zone = dnsZone(scope, id, domain);
  const certificate = new Certificate(scope, `${id}Cert`, {
    domainName: domain.name,
    validation: CertificateValidation.fromDns(zone),
  });
  const apiDomain = new apigateway.DomainName(scope, `${id}DomainName`, {
    domainName: domain.name,
    certificate,
    endpointType: apigateway.EndpointType.REGIONAL,
    securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
  });
  new apigateway.BasePathMapping(scope, `${id}Mapping`, {
    domainName: apiDomain,
    restApi: api,
    stage: api.deploymentStage,
  });
  const target = RecordTarget.fromAlias(new ApiGatewayDomain(apiDomain));
  new ARecord(scope, `${id}AliasA`, { zone, recordName: domain.name, target });
  new AaaaRecord(scope, `${id}AliasAaaa`, { zone, recordName: domain.name, target });
  new CfnOutput(scope, `${id}DomainUrl`, {
    value: `https://${domain.name}`,
    description: `Custom domain of the ${specName} API`,
  });
}

/** Cognito authorizer backed by a same-stack auth component, if configured. */
function authorizerFor(
  scope: Construct,
  apiId: string,
  authName: string | undefined,
  built: ReadonlyMap<string, BuiltComponent>,
): apigateway.CognitoUserPoolsAuthorizer | undefined {
  if (!authName) return undefined;
  const auth = built.get(authName);
  if (!auth?.userPool) {
    // The loader validates auth references; reaching this means a programming error.
    throw new ForgeError(`Cannot attach auth "${authName}": auth component was not built first`);
  }
  return new apigateway.CognitoUserPoolsAuthorizer(scope, `${apiId}Authorizer`, {
    cognitoUserPools: [auth.userPool],
  });
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

export function buildComponent(
  scope: Construct,
  spec: ComponentSpec,
  ctx: BuildContext,
  built: ReadonlyMap<string, BuiltComponent>,
): BuiltComponent {
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
        // only its code. CORS is the gateway's setting, but the response
        // header must come from THIS Lambda (proxy integration), so the
        // gateway's origins are injected here, in the Lambda's own stack.
        const gateway = resolveBinding(ctx.model, ctx.domain, spec.config.mount)?.component;
        if (gateway && !('pack' in gateway) && gateway.type === 'gateway') {
          const origins = corsOrigins(gateway.config.cors);
          if (origins) fn.addEnvironment('CORS_ORIGIN', origins.join(','));
        }
        return { spec, resource: fn, lambda: fn };
      }
      // REST API (payload v1) with one explicit resource per route: fusion-server
      // routes by exact `httpMethod + resource` match, so the API definition and
      // the controller decorators must mirror each other.
      const api = new apigateway.RestApi(scope, `${id}RestApi`, {
        restApiName: physicalName(ctx, spec.name, 128),
        cloudWatchRole: false,
        deployOptions: { stageName: ctx.environment, tracingEnabled: true },
        defaultCorsPreflightOptions: corsPreflight(spec.config.cors),
      });
      const ownOrigins = corsOrigins(spec.config.cors);
      if (ownOrigins) fn.addEnvironment('CORS_ORIGIN', ownOrigins.join(','));
      addRestRoutes(
        api,
        spec.config.routes,
        new apigateway.LambdaIntegration(fn),
        authorizerFor(scope, id, spec.config.auth, built),
      );
      attachApiDomain(scope, id, spec.name, spec.config.domain, api, ctx);
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
        defaultCorsPreflightOptions: corsPreflight(spec.config.cors),
      });
      const authorizer = authorizerFor(scope, id, spec.config.auth, built);
      let mounted = 0;
      for (const domain of ctx.model.domains) {
        for (const component of domain.components) {
          if (component.type !== 'http-api' || !component.config.mount) continue;
          const resolved = resolveBinding(ctx.model, domain, component.config.mount);
          if (resolved?.domain.name !== ctx.domain.name || resolved.component.name !== spec.name) continue;

          const functionArn = `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:function:${resourceNameFor(ctx.model.name, domain.name, component.name, ctx.environment)}`;
          const importId = `${id}${toConstructId(domain.name)}${toConstructId(component.name)}`;
          // skipPermissions: the invoke permission is granted explicitly below
          // (CfnPermission) — this also silences CDK's addPermission warning.
          const target = LambdaFunction.fromFunctionAttributes(scope, `${importId}Fn`, {
            functionArn,
            skipPermissions: true,
          });
          addRestRoutes(api, component.config.routes, new apigateway.LambdaIntegration(target), authorizer);
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
      attachApiDomain(scope, id, spec.name, spec.config.domain, api, ctx);
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

    case 'auth': {
      const pool = new cognito.UserPool(scope, `${id}UserPool`, {
        userPoolName: physicalName(ctx, spec.name, 128),
        selfSignUpEnabled: spec.config.selfSignUp,
        signInAliases: { email: true },
        autoVerify: { email: true },
        passwordPolicy: {
          minLength: 12,
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
        },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy: statefulRemovalPolicy(ctx),
      });
      const client = pool.addClient(`${id}Client`, {
        authFlows: { userSrp: true },
        generateSecret: false,
      });
      new CfnOutput(scope, `${id}UserPoolId`, {
        value: pool.userPoolId,
        description: `User pool id of ${spec.name} (frontend config)`,
      });
      new CfnOutput(scope, `${id}ClientId`, {
        value: client.userPoolClientId,
        description: `App client id of ${spec.name} (frontend config)`,
      });
      return { spec, resource: pool, userPool: pool };
    }

    case 'email': {
      const isAddress = spec.config.identity.includes('@');
      const identity = new EmailIdentity(scope, `${id}Identity`, {
        identity: isAddress ? Identity.email(spec.config.identity) : Identity.domain(spec.config.identity),
      });
      if (isAddress) {
        new CfnOutput(scope, `${id}Verification`, {
          value: `SES sent a verification email to ${spec.config.identity} — confirm it before sending`,
          description: `Verification status hint for ${spec.name}`,
        });
      } else {
        // Domain identities verify through DNS: publish these DKIM CNAMEs.
        identity.dkimRecords.forEach((record, index) => {
          new CfnOutput(scope, `${id}Dkim${index + 1}`, {
            value: `${record.name} CNAME ${record.value}`,
            description: `DKIM record ${index + 1} for ${spec.config.identity}`,
          });
        });
      }
      return {
        spec,
        resource: identity,
        grant: (grantee) => identity.grantSendEmail(grantee),
        bindingEnv: { [bindingEnvVarFor(spec.type, spec.name)!]: spec.config.identity },
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

      // API behind the distribution: /api/* forwards to the same-module REST
      // API (gateway or unmounted http-api). Same origin for the browser →
      // no CORS anywhere, and the execute-api URL is never exposed. A
      // CloudFront Function strips the /api prefix so the API keeps its own
      // route paths; originPath adds the stage.
      const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
      if (spec.config.api) {
        const target = built.get(spec.config.api)?.resource;
        if (!(target instanceof apigateway.RestApi)) {
          // The loader validates config.api; reaching this means a build-order bug.
          throw new ForgeError(`Cannot serve api "${spec.config.api}": its REST API was not built first`);
        }
        const rewrite = new cloudfront.Function(scope, `${id}ApiRewrite`, {
          code: cloudfront.FunctionCode.fromInline(
            "function handler(event) { var request = event.request; request.uri = request.uri.replace(/^\\/api/, '') || '/'; return request; }",
          ),
          comment: `strip /api before forwarding to the ${spec.config.api} API`,
        });
        additionalBehaviors['/api/*'] = {
          origin: new HttpOrigin(`${target.restApiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}`, {
            originPath: `/${ctx.environment}`,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Never forward the viewer Host header — execute-api routes by Host.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [{ function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        };
      }

      const domainConfig = activeDomain(spec.config.domain, ctx);
      let zone: IHostedZone | undefined;
      let certificate: Certificate | undefined;
      if (domainConfig) {
        const region = ctx.model.environments[ctx.environment]?.region;
        if (region !== 'us-east-1') {
          throw new ForgeError(
            `Component "${ctx.domain.name}/${spec.name}": a CloudFront custom domain requires the stack to live in us-east-1 (environment "${ctx.environment}" is in ${region})`,
            'CloudFront only accepts ACM certificates issued in us-east-1. Use a us-east-1 environment for this domain, or restrict domain.environments.',
          );
        }
        zone = dnsZone(scope, id, domainConfig);
        certificate = new Certificate(scope, `${id}Cert`, {
          domainName: domainConfig.name,
          validation: CertificateValidation.fromDns(zone),
        });
      }

      const distribution = new cloudfront.Distribution(scope, `${id}Distribution`, {
        defaultBehavior: {
          origin: S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        additionalBehaviors,
        defaultRootObject: 'index.html',
        errorResponses: spec.config.spa
          ? [
              { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
              { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
            ]
          : undefined,
        webAclId: webAcl?.attrArn,
        domainNames: domainConfig ? [domainConfig.name] : undefined,
        certificate,
      });

      if (domainConfig && zone) {
        const aliasTarget = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
        new ARecord(scope, `${id}AliasA`, { zone, recordName: domainConfig.name, target: aliasTarget });
        new AaaaRecord(scope, `${id}AliasAaaa`, { zone, recordName: domainConfig.name, target: aliasTarget });
      }

      const sourceDir = path.join(spec.path, spec.config.sourceDir);
      if (fs.existsSync(sourceDir)) {
        new BucketDeployment(scope, `${id}Deployment`, {
          sources: [Source.asset(sourceDir)],
          destinationBucket: bucket,
          distribution,
          distributionPaths: ['/*'],
        });
      } else {
        // Not built yet: fine for synth/tests (backend work must not block on
        // a frontend build), but `forge deploy` refuses — an empty private
        // bucket behind CloudFront would 403 every request.
        Annotations.of(scope).addWarningV2(
          'forge:static-site-not-built',
          `"${ctx.domain.name}/${spec.name}": source directory "${spec.config.sourceDir}" does not exist — assets will NOT deploy until you build the frontend`,
        );
      }

      new CfnOutput(scope, `${id}Url`, {
        value: domainConfig ? `https://${domainConfig.name}` : `https://${distribution.distributionDomainName}`,
        description: `URL of the ${spec.name} site`,
      });
      return { spec, resource: distribution };
    }
  }

  throw new ForgeError(`Unsupported component type "${(spec as ComponentSpec).type}"`);
}
