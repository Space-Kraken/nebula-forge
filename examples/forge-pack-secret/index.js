'use strict';

/**
 * Example forge component pack. A pack default-exports:
 *   { name, components: [{ type, configSchema, bindable?, docs?, scaffold?, engines }] }
 *
 * This one adds a `secret` component type backed by AWS Secrets Manager.
 * Functions in the same domain can bind to it with `access: read` and receive
 * a SECRET_<NAME>_ARN env var plus secretsmanager:GetSecretValue permissions.
 *
 * zod and aws-cdk-lib are peer dependencies: they resolve from the workspace
 * that installs the pack, so the constructs share the workspace's CDK version.
 */
const { z } = require('zod');

/** @type {import('@space-kraken/nebula-forge-core').ComponentPack} */
const pack = {
  name: 'forge-pack-secret',
  components: [
    {
      type: 'secret',
      description: 'Secrets Manager secret (bind with access: read)',
      // Keep config schemas strict: unknown keys must fail, not vanish.
      configSchema: z
        .object({
          /** Optional description shown in the AWS console. */
          description: z.string().optional(),
          /** Generate a random value at deploy time (default true). */
          generate: z.boolean().default(true),
        })
        .strict()
        .default({}),
      bindable: {
        access: ['read'],
        envVar: { prefix: 'SECRET', suffix: 'ARN' },
      },
      docs: { badge: '🔑' },
      scaffold: [
        {
          path: 'README.md',
          content:
            '# {{name}}\n\nSecrets Manager secret in the `{{module}}` domain.\n\n' +
            'Bind a function to it (`forge attach`) and read it at runtime:\n\n' +
            '```ts\n' +
            "const arn = process.env.SECRET_{{screamingName}}_ARN;\n" +
            '// new SecretsManagerClient().send(new GetSecretValueCommand({ SecretId: arn }))\n' +
            '```\n',
        },
      ],
      engines: {
        /** @type {import('@space-kraken/nebula-forge-engine-cdk').AwsPackBuilder} */
        'aws-cdk': (scope, spec, ctx) => {
          const { Secret } = require('aws-cdk-lib/aws-secretsmanager');
          const secret = new Secret(scope, `Secret${spec.name}`, {
            secretName: `${ctx.model.name}-${ctx.domain.name}-${spec.name}-${ctx.environment}`,
            description: spec.config.description,
          });
          return {
            resource: secret,
            grant: (grantee) => secret.grantRead(grantee),
            bindingEnv: {
              // Same convention as core's toEnvVarName: SECRET_<NAME>_ARN.
              [`SECRET_${spec.name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_ARN`]: secret.secretArn,
            },
          };
        },
      },
    },
  ],
};

module.exports = pack;
