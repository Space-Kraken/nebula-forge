import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { ForgeError } from '@forgecli/core';
import type { DomainSpec, WorkspaceModel } from '@forgecli/core';
import type { Stack } from 'aws-cdk-lib';
import type { BuiltComponent } from './types';

/** What a domain's extend.ts receives on the aws-cdk engine. */
export interface ExtendContext {
  /** The domain stack — add any CDK construct here. */
  stack: Stack;
  model: WorkspaceModel;
  domain: DomainSpec;
  environment: string;
  /** Resources forge built, by component name (lambda, queue, userPool, …). */
  components: ReadonlyMap<string, BuiltComponent>;
}

export type ExtendFunction = (ctx: ExtendContext) => void;

/**
 * Transpiles and evaluates an extend file (.ts or .js) in-process. esbuild
 * keeps node_modules imports external and CommonJS `require` resolves them
 * from the workspace — works identically under node, tsx and vitest.
 */
function loadExtendFile(file: string): unknown {
  const result = buildSync({
    entryPoints: [file],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    packages: 'external',
    sourcemap: 'inline',
  });
  const code = result.outputFiles[0].text;
  const module = { exports: {} as Record<string, unknown> };
  const evaluate = new Function('module', 'exports', 'require', '__dirname', '__filename', code);
  evaluate(module, module.exports, createRequire(file), path.dirname(file), file);
  return module.exports;
}

/**
 * The escape hatch: if domains/<module>/extend.ts (or .js) exists, it runs
 * with full CDK access INSIDE the domain stack — for the 5% forge does not
 * model, without leaving the tool.
 */
export function applyExtension(ctx: ExtendContext): void {
  const file = ['extend.ts', 'extend.js']
    .map((candidate) => path.join(ctx.domain.path, candidate))
    .find((candidate) => fs.existsSync(candidate));
  if (!file) return;

  let extension: unknown;
  try {
    extension = loadExtendFile(file);
  } catch (error) {
    throw new ForgeError(
      `Could not load ${file}: ${(error as Error).message}`,
      'The extend file must be valid TypeScript/JavaScript exporting a default function (ctx) => void.',
    );
  }
  const exported = extension as { default?: unknown; extend?: unknown };
  const fn = exported.default ?? exported.extend ?? extension;
  if (typeof fn !== 'function') {
    throw new ForgeError(
      `${file} does not export an extension function`,
      'Export default a function: `export default function extend(ctx: ExtendContext) { … }`.',
    );
  }
  try {
    (fn as ExtendFunction)(ctx);
  } catch (error) {
    throw new ForgeError(
      `extend.ts of module "${ctx.domain.name}" failed: ${(error as Error).message}`,
      'Fix the extension code — it runs inside the domain stack during synthesis.',
    );
  }
}
