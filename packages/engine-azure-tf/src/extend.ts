import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { ForgeError } from '@forgecli/core';
import type { DomainSpec, WorkspaceModel } from '@forgecli/core';
import type { TfDocument } from './tf';

/** What a domain's extend.ts receives on the azure-terraform engine. */
export interface AzureExtendContext {
  /** The domain's Terraform JSON document — mutate it to add anything. */
  document: TfDocument;
  model: WorkspaceModel;
  domain: DomainSpec;
  environment: string;
}

export type AzureExtendFunction = (ctx: AzureExtendContext) => void;

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

/** Escape hatch: domains/<module>/extend.ts mutates the Terraform document. */
export function applyExtension(ctx: AzureExtendContext): void {
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
    throw new ForgeError(`${file} does not export an extension function`);
  }
  try {
    (fn as AzureExtendFunction)(ctx);
  } catch (error) {
    throw new ForgeError(`extend.ts of module "${ctx.domain.name}" failed: ${(error as Error).message}`);
  }
}
