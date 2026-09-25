'use strict';

const standards = require('./index.js');

/**
 * forge adapter: maps the org's vocabulary onto forge's conventions contract.
 * forge calls it with the workspace context on every command and validates
 * what it returns (strict shape, schemaVersion). Deterministic, synchronous,
 * no network — a pure function of `ctx`.
 *
 * Mapping COMPOSES into forge's fixed vocabulary ({project} {module} {name}
 * {env}); it never adds dimensions. An org dimension forge does not model
 * (a client, a region) is folded into {project} by the workspace name.
 */
const VOCABULARY = { app: 'project', stage: 'env', domain: 'module', resource: 'name' };

function translate(template) {
  return template.replace(/\{(\w+)\}/g, (token, key) => {
    const mapped = VOCABULARY[key];
    if (!mapped) throw new Error(`standards token {${key}} has no forge equivalent`);
    return `{${mapped}}`;
  });
}

module.exports = function forgeConventions(ctx) {
  if (ctx.forge.conventionsSchemaVersion !== 1) {
    throw new Error(`this adapter targets forge conventions schemaVersion 1, forge speaks ${ctx.forge.conventionsSchemaVersion}`);
  }

  const tags = { builtin: false };
  for (const [key, value] of Object.entries(standards.labels)) tags[key] = translate(value);

  const environments = {};
  if (ctx.engine === 'aws-cdk') {
    const { landingZone } = standards;
    for (const [env, spec] of Object.entries(ctx.environments)) {
      if (!spec.account) throw new Error(`environment "${env}" needs "account" in forge.json to build the execution policy ARNs`);
      environments[env] = {
        deploy: {
          qualifier: `${landingZone.qualifierPrefix}${env}`,
          permissionsBoundary: landingZone.boundary,
          executionPolicies: landingZone.executionPolicies(spec.account, env),
        },
      };
    }
  }

  return {
    schemaVersion: 1,
    naming: { pattern: translate(standards.resourceName) },
    tags,
    environments,
  };
};
