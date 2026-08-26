import * as path from 'node:path';
import { loadWorkspace } from '@forgecli/core';
import { createApp } from '@forgecli/engine-cdk';

// Entry point executed by the CDK CLI (see cdk.json). The forge CLI selects
// the environment through FORGE_ENV; it falls back to defaultEnvironment.
const model = loadWorkspace(path.resolve(__dirname, '..'));
const environment = process.env.FORGE_ENV ?? model.defaultEnvironment;
const { app } = createApp(model, { environment });
app.synth();
