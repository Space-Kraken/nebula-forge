import * as path from 'node:path';
import { loadWorkspace, renderArchitectureMarkdown } from '@forgecli/core';
import { writeFile } from './templates';

export const ARCHITECTURE_DOC = path.join('docs', 'architecture.md');

/**
 * (Re)generates docs/architecture.md from the current workspace model.
 * Called by every command that changes the architecture, so the docs and the
 * diagram never drift from reality.
 */
export function writeArchitectureDocs(root: string): string {
  const model = loadWorkspace(root);
  const target = path.join(root, ARCHITECTURE_DOC);
  writeFile(target, renderArchitectureMarkdown(model));
  return target;
}
