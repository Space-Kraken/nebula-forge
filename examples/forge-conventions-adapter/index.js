'use strict';

/**
 * The org's cloud standards, tool-agnostic: consumed by IAM policy
 * generators, validators and docs as much as by forge. Nothing here knows
 * forge's vocabulary — that is the adapter's job (./forge.js).
 *
 * Names use the org's own dimensions: {app} {stage} {domain} {resource}.
 * Labels are the org's tag scheme. The landing zone block describes the
 * custom CDK bootstrap every account provisions.
 */
module.exports = {
  resourceName: '{app}-{stage}-{domain}-{resource}',
  labels: {
    'acme:app': '{app}',
    'acme:stage': '{stage}',
    'acme:domain': '{domain}',
    'acme:cost-center': 'cc-0001',
    'acme:managed-by': 'cdk',
  },
  landingZone: {
    qualifierPrefix: 'ac',
    boundary: 'acme-platform-boundary',
    /** Execution policies granted to the deploy role, per account and stage. */
    executionPolicies: (account, stage) =>
      ['compute', 'data', 'edge'].map((box) => `arn:aws:iam::${account}:policy/acme-box-${stage}-${box}`),
  },
};
