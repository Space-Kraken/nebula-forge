import { loadWorkspace } from '@forgecli/core';
import { synthesizeDomain } from '@forgecli/engine-azure-tf';
import { describe, expect, it } from 'vitest';

describe('{{module}} infrastructure', () => {
  it('synthesizes valid Terraform', () => {
    const model = loadWorkspace(process.cwd());
    const document = synthesizeDomain(model, '{{module}}', model.defaultEnvironment);

    expect(document.resource).toBeDefined();
    // Snapshot of the Terraform JSON: review the diff when it changes.
    expect(document).toMatchSnapshot();
  });
});
