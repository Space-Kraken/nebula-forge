import type { WorkspaceModel } from './model';

export interface SynthOptions {
  environment: string;
  /** Cloud-assembly output directory; the engine picks one when omitted. */
  outdir?: string;
  /** Restrict synthesis to these domains; all domains when omitted. */
  domains?: string[];
}

export interface SynthesizedStack {
  domain: string;
  stackName: string;
}

export interface SynthResult {
  outdir: string;
  stacks: SynthesizedStack[];
}

/**
 * A synthesis engine turns the agnostic workspace model into deployable
 * infrastructure for one provider. aws-cdk is the first implementation;
 * additional engines (other clouds) implement this same contract.
 */
export interface Engine {
  readonly id: string;
  synth(model: WorkspaceModel, options: SynthOptions): Promise<SynthResult>;
}
