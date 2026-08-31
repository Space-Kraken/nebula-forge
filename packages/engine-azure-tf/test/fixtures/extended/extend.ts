import type { AzureExtendContext } from '../../../src/extend';

// Escape-hatch fixture: raw Terraform JSON mutation.
export default function extend(ctx: AzureExtendContext): void {
  ctx.document.output.extended = { value: `from-extend-${ctx.environment}` };
}
