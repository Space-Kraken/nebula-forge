import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWorkspace, workspaceManifestSchema } from '@space-kraken/nebula-forge-core';
import type { WorkspaceModel } from '@space-kraken/nebula-forge-core';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapArgs, toolkitStackNameFor } from '../src/lib/engines/aws-cdk';

const createdDirs: string[] = [];
afterEach(() => {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function model(env: Record<string, unknown>): WorkspaceModel {
  return {
    name: 'shop',
    engine: 'aws-cdk',
    defaultEnvironment: 'dev',
    environments: { dev: { region: 'us-east-1', ...env } },
    root: '/na',
    domains: [],
  } as WorkspaceModel;
}

describe('deploy identity (environments.<env>.deploy)', () => {
  it('without the block, bootstrap argv is byte-identical to the historic call', () => {
    expect(bootstrapArgs(model({}), 'dev')).toEqual(['cdk', 'bootstrap']);
    expect(bootstrapArgs(model({ account: '111122223333' }), 'dev')).toEqual([
      'cdk',
      'bootstrap',
      'aws://111122223333/us-east-1',
    ]);
  });

  it('passes qualifier, permissions boundary and execution policies through to cdk bootstrap', () => {
    const argv = bootstrapArgs(
      model({
        account: '111122223333',
        deploy: {
          qualifier: 'corp1',
          permissionsBoundary: 'org-boundary',
          executionPolicies: ['arn:aws:iam::111122223333:policy/DeployA', 'arn:aws:iam::111122223333:policy/DeployB'],
        },
      }),
      'dev',
    );
    expect(argv).toEqual([
      'cdk',
      'bootstrap',
      'aws://111122223333/us-east-1',
      '--qualifier',
      'corp1',
      '--toolkit-stack-name',
      'CDKToolkit-corp1',
      '--custom-permissions-boundary',
      'org-boundary',
      '--cloudformation-execution-policies',
      'arn:aws:iam::111122223333:policy/DeployA',
      '--cloudformation-execution-policies',
      'arn:aws:iam::111122223333:policy/DeployB',
    ]);
  });

  it('names the bootstrap stack after the qualifier so environments sharing an account do not collide', () => {
    expect(toolkitStackNameFor('ixqa')).toBe('CDKToolkit-ixqa');
    const dev = bootstrapArgs(model({ deploy: { qualifier: 'ixdev' } }), 'dev');
    const qa = bootstrapArgs(model({ deploy: { qualifier: 'ixqa' } }), 'dev');
    expect(dev).toContain('CDKToolkit-ixdev');
    expect(qa).toContain('CDKToolkit-ixqa');
    // boundary/policies alone never rename the stack: that is cdk's default bootstrap
    expect(bootstrapArgs(model({ deploy: { permissionsBoundary: 'org-boundary' } }), 'dev')).not.toContain(
      '--toolkit-stack-name',
    );
  });

  it('rejects invalid qualifiers in the schema', () => {
    const parsed = workspaceManifestSchema.safeParse({
      name: 'shop',
      engine: 'aws-cdk',
      defaultEnvironment: 'dev',
      environments: { dev: { region: 'us-east-1', deploy: { qualifier: 'WAY_TOO_LONG_Q' } } },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects the deploy block on the azure-terraform engine at load time', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-deploy-test-'));
    createdDirs.push(root);
    fs.writeFileSync(
      path.join(root, 'forge.json'),
      JSON.stringify({
        name: 'shop',
        engine: 'azure-terraform',
        defaultEnvironment: 'dev',
        environments: { dev: { region: 'eastus', deploy: { qualifier: 'corp1' } } },
      }),
    );
    expect(() => loadWorkspace(root)).toThrow(/"deploy" block, which the azure-terraform engine does not support/);
  });
});
