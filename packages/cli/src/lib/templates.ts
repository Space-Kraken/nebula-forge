import * as fs from 'node:fs';
import * as path from 'node:path';

// dist/lib → package root → templates/
const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

export function renderTemplate(relativePath: string, vars: Record<string, string>): string {
  let content = fs.readFileSync(path.join(TEMPLATES_DIR, relativePath), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.split(`{{${key}}}`).join(value);
  }
  return content;
}

export function writeFile(targetFile: string, content: string): void {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, content);
}

export function writeRendered(
  targetFile: string,
  relativeTemplate: string,
  vars: Record<string, string>,
): void {
  writeFile(targetFile, renderTemplate(relativeTemplate, vars));
}

export function writeJson(targetFile: string, value: unknown): void {
  writeFile(targetFile, `${JSON.stringify(value, null, 2)}\n`);
}
