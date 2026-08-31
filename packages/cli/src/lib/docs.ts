import * as path from 'node:path';
import { loadWorkspace, renderAgentGuide, renderArchitectureMarkdown } from '@forgecli/core';
import { writeFile } from './templates';

export const ARCHITECTURE_DOC = path.join('docs', 'architecture.md');
export const AGENT_GUIDE = 'AGENTS.md';

/**
 * (Re)generates docs/architecture.md AND AGENTS.md (project knowledge for AI
 * coding agents) from the current workspace model. Called by every command
 * that changes the architecture, so neither ever drifts from reality.
 */
export function writeArchitectureDocs(root: string): string {
  const model = loadWorkspace(root);
  const target = path.join(root, ARCHITECTURE_DOC);
  writeFile(target, renderArchitectureMarkdown(model));
  writeFile(path.join(root, AGENT_GUIDE), renderAgentGuide(model));
  return target;
}
