import type { AnyComponentSpec, BindingAccess } from '@space-kraken/nebula-forge-core';
import type { IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { IEventBus } from 'aws-cdk-lib/aws-events';
import type { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import type { IConstruct } from 'constructs';

/** A component after synthesis, with the hooks bindings need. */
export interface BuiltComponent {
  spec: AnyComponentSpec;
  resource: IConstruct;
  /** Present for function-like components (the binding consumer side). */
  lambda?: LambdaFunction;
  /** Present for queue-worker components (subscription delivery target). */
  queue?: Queue;
  /** Present for event-bus components (same-stack subscription source). */
  eventBus?: IEventBus;
  /** Present for auth components (same-stack authorizer source). */
  userPool?: IUserPool;
  /** Grants a consumer the requested access; present for bindable targets. */
  grant?: (grantee: LambdaFunction, access: BindingAccess) => void;
  /** Environment variables injected into consumers that bind to this component. */
  bindingEnv?: Record<string, string>;
}
