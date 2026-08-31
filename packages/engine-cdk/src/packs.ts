import type { PackComponentSpec } from '@forgecli/core';
import type { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import type { Construct, IConstruct } from 'constructs';
import type { BuildContext } from './builders';

/** What a pack's aws-cdk builder returns (merged into the components map). */
export interface AwsPackBuilt {
  resource: IConstruct;
  /** Grants a consumer the requested access when something binds to this component. */
  grant?: (grantee: LambdaFunction, access: string) => void;
  /** Discovery env vars injected into consumers that bind to this component. */
  bindingEnv?: Record<string, string>;
}

/**
 * The builder a pack provides under engines["aws-cdk"]. It receives the
 * domain stack scope, the parsed component spec (config already validated by
 * the pack's schema) and the build context (model/domain/environment/
 * production flag).
 */
export type AwsPackBuilder = (scope: Construct, spec: PackComponentSpec, ctx: BuildContext) => AwsPackBuilt;
