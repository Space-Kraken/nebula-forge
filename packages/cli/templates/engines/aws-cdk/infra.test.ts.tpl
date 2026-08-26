import { Template } from 'aws-cdk-lib/assertions';
import { loadWorkspace } from '@forgecli/core';
import { createApp } from '@forgecli/engine-cdk';
import { describe, expect, it } from 'vitest';

describe('{{module}} infrastructure', () => {
  it('synthesizes a valid stack', () => {
    const model = loadWorkspace(process.cwd());
    const { stacks } = createApp(model, {
      environment: model.defaultEnvironment,
      domains: ['{{module}}'],
    });
    const template = Template.fromStack(stacks.get('{{module}}')!);

    // Snapshot of the CloudFormation template: review the diff when it changes
    // (asset hashes change whenever handler code changes — that is expected).
    expect(template.toJSON()).toMatchSnapshot();
  });
});
