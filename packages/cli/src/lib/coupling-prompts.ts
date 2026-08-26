import { BINDABLE_ACCESS } from '@forgecli/core';
import type { Binding, BindingAccess, DomainSpec, WorkspaceModel } from '@forgecli/core';
import type { Subscription } from './attach';
import { promptCheckbox, promptConfirm, promptInput, promptSelect } from './interactive';

/**
 * Interactive coupling questions shared by `generate component` (new
 * components) and `attach` (existing ones). Callers are responsible for
 * gating on canPrompt().
 */

/** "What should <subject> use?" — bindable siblings plus event buses anywhere. */
export async function promptOutboundBindings(
  model: WorkspaceModel,
  domain: DomainSpec,
  subjectName: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<Binding[]> {
  const local = domain.components
    .filter((component) => BINDABLE_ACCESS[component.type] && component.name !== subjectName)
    .map((component) => ({ ref: component.name, type: component.type }));
  const remoteBuses = model.domains
    .filter((candidate) => candidate.name !== domain.name)
    .flatMap((candidate) =>
      candidate.components
        .filter((component) => component.type === 'event-bus')
        .map((component) => ({ ref: `${candidate.name}/${component.name}`, type: component.type })),
    );
  const targets = [...local, ...remoteBuses].filter((target) => !exclude.has(target.ref));
  if (targets.length === 0) return [];

  const selected = await promptCheckbox(
    `Attach ${subjectName} to existing resources?`,
    targets.map((target) => ({ name: `${target.ref} (${target.type})`, value: target })),
  );
  const bindings: Binding[] = [];
  for (const target of selected) {
    const allowed = BINDABLE_ACCESS[target.type] ?? [];
    const access =
      allowed.length === 1
        ? allowed[0]
        : await promptSelect<BindingAccess>(
            `Access for ${subjectName} → ${target.ref}:`,
            allowed.map((mode) => ({ name: mode, value: mode })),
            'read-write' as BindingAccess,
          );
    bindings.push({ component: target.ref, access });
  }
  return bindings;
}

/** "Should <subject> react to an event bus?" */
export async function promptBusSubscription(
  model: WorkspaceModel,
  domain: DomainSpec,
  subjectName: string,
  warn: (message: string) => void,
): Promise<Subscription[]> {
  const buses = model.domains.flatMap((candidate) =>
    candidate.components
      .filter((component) => component.type === 'event-bus')
      .map((component) => (candidate.name === domain.name ? component.name : `${candidate.name}/${component.name}`)),
  );
  if (buses.length === 0) return [];
  if (!(await promptConfirm(`Subscribe ${subjectName} to an event bus?`, false))) return [];

  const bus =
    buses.length === 1
      ? buses[0]
      : await promptSelect(
          'Which bus?',
          buses.map((candidate) => ({ name: candidate, value: candidate })),
        );
  const source = (await promptInput('Match source(s), comma-separated (empty to skip):', '')).trim();
  const detailType = (await promptInput('Match detail-type(s), comma-separated (empty to skip):', '')).trim();
  const pattern: Subscription['pattern'] = {};
  if (source) pattern.source = source.split(',').map((value) => value.trim()).filter(Boolean);
  if (detailType) pattern.detailType = detailType.split(',').map((value) => value.trim()).filter(Boolean);
  if (!pattern.source && !pattern.detailType) {
    warn('No pattern given — skipping the subscription (add it later with forge attach).');
    return [];
  }
  return [{ bus, pattern }];
}
