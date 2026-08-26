/**
 * API route grammar shared by the schema, the loader and the CLI. API Gateway
 * REST only accepts path parts of [A-Za-z0-9._-] or a whole-part variable
 * "{name}" / greedy "{name+}", and a greedy part must be the final segment —
 * anything else fails at synth or deploy, so forge rejects it up front.
 */

const LITERAL_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const VARIABLE_SEGMENT = /^\{[a-zA-Z][a-zA-Z0-9_]*\+?\}$/;

/** Returns every problem with an API route path; empty array = valid. */
export function routePathIssues(path: string): string[] {
  if (!path.startsWith('/')) return [`route "${path}" must start with "/"`];
  if (path === '/') return [];
  const issues: string[] = [];
  const segments = path.slice(1).split('/');
  segments.forEach((segment, index) => {
    if (segment === '') {
      issues.push(`route "${path}" has an empty path segment`);
      return;
    }
    if (LITERAL_SEGMENT.test(segment)) return;
    if (VARIABLE_SEGMENT.test(segment)) {
      if (segment.endsWith('+}') && index !== segments.length - 1) {
        issues.push(`greedy segment "${segment}" must be the last segment of "${path}"`);
      }
      return;
    }
    issues.push(
      `segment "${segment}" in "${path}" is invalid — use letters/digits/._- or a whole-segment variable like {id} (greedy: {proxy+})`,
    );
  });
  return issues;
}

/** True when the segment is a path variable ({id} or {proxy+}). */
export function isVariableSegment(segment: string): boolean {
  return VARIABLE_SEGMENT.test(segment);
}
