import { CfnOutput } from 'aws-cdk-lib';
import type { ExtendContext } from '../../../src/extend';

// Escape-hatch fixture: raw CDK inside the domain stack.
export default function extend(ctx: ExtendContext): void {
  new CfnOutput(ctx.stack, 'ExtendedOutput', { value: `from-extend-${ctx.environment}` });
}
