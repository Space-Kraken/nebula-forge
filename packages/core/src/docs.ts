import { resolveBinding } from './loader';
import type { ComponentSpec, DomainSpec, WorkspaceModel } from './model';
import { bindingEnvVarFor, stackNameFor } from './names';

/**
 * Architecture documentation generated straight from the workspace model:
 * a Mermaid overview diagram (renders natively on GitHub/GitLab) plus one
 * section per module. Deliberately high-level — the goal is the diagram a
 * teammate sketches on a whiteboard, not a resource-by-resource inventory.
 */

const TYPE_BADGES: Record<string, string> = {
  'http-api': '🌐',
  function: '⚡',
  'queue-worker': '⚙️',
  table: '🗄️',
  bucket: '🪣',
  topic: '📣',
  'static-site': '🖥️',
  'event-bus': '🚌',
};

interface NodeShape {
  open: string;
  close: string;
}

// Shape vocabulary: stadium = entry point, subroutine = worker,
// cylinder = storage, hexagon = pub/sub, circle = event bus,
// parallelogram = static site.
const TYPE_SHAPES: Record<string, NodeShape> = {
  'http-api': { open: '([', close: '])' },
  function: { open: '[', close: ']' },
  'queue-worker': { open: '[[', close: ']]' },
  table: { open: '[(', close: ')]' },
  bucket: { open: '[(', close: ')]' },
  topic: { open: '{{', close: '}}' },
  'static-site': { open: '[/', close: '/]' },
  'event-bus': { open: '((', close: '))' },
};

/** Mermaid edge labels go inside |"…"|; keep quotes out of the raw text. */
function edgeLabel(text: string): string {
  return `|"${text.replace(/"/g, '#quot;')}"|`;
}

/** Mermaid ids allow only word characters; labels carry the real names. */
function mermaidId(...parts: string[]): string {
  return parts.join('__').replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Subgraph ids never contain "__" while node ids always do (domain__component
 * with kebab names that cannot hold underscores), so the two namespaces are
 * provably disjoint — a domain named e.g. "dom" cannot collide with a node.
 */
function subgraphId(domainName: string): string {
  return `sg_${domainName.replace(/[^A-Za-z0-9]/g, '_')}`;
}

function nodeFor(domain: DomainSpec, component: ComponentSpec): string {
  const id = mermaidId(domain.name, component.name);
  const shape = TYPE_SHAPES[component.type] ?? { open: '[', close: ']' };
  const badge = TYPE_BADGES[component.type] ?? '';
  const label = `"${badge} ${component.name}<br/><i>${component.type}</i>"`;
  return `    ${id}${shape.open}${label}${shape.close}`;
}

export function renderArchitectureMermaid(model: WorkspaceModel): string {
  const lines: string[] = ['flowchart LR'];

  if (model.domains.length === 0) {
    // No angle brackets here: mermaid's HTML sanitizer would strip them.
    lines.push('  empty["(no modules yet — run forge generate module)"]');
    return lines.join('\n');
  }

  for (const domain of model.domains) {
    lines.push(`  subgraph ${subgraphId(domain.name)}["📦 ${domain.name}"]`);
    if (domain.components.length === 0) {
      lines.push(`    ${mermaidId(domain.name, 'empty')}["(no components)"]`);
    }
    for (const component of domain.components) {
      lines.push(nodeFor(domain, component));
    }
    lines.push('  end');
  }

  for (const domain of model.domains) {
    for (const component of domain.components) {
      const from = mermaidId(domain.name, component.name);
      for (const binding of component.bindings) {
        const resolved = resolveBinding(model, domain, binding);
        if (!resolved) continue;
        const to = mermaidId(resolved.domain.name, resolved.component.name);
        // Dashed arrows mark cross-domain (event) integration.
        const arrow = resolved.domain.name === domain.name ? '-->' : '-.->';
        lines.push(`  ${from} ${arrow}${edgeLabel(binding.access)} ${to}`);
      }
      if (component.type === 'queue-worker' || component.type === 'function') {
        for (const subscription of component.config.subscriptions) {
          const resolved = resolveBinding(model, domain, subscription.bus);
          if (!resolved) continue;
          const bus = mermaidId(resolved.domain.name, resolved.component.name);
          const label =
            subscription.pattern.source?.join(', ') ?? subscription.pattern.detailType?.join(', ') ?? 'events';
          lines.push(`  ${bus} -.->${edgeLabel(label)} ${from}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/** Escapes characters that would break a Markdown table cell. */
function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function componentRow(model: WorkspaceModel, domain: DomainSpec, component: ComponentSpec): string {
  const badge = TYPE_BADGES[component.type] ?? '';

  const relations = component.bindings.map((binding) => `→ ${binding.component} (${binding.access})`);
  if (component.type === 'queue-worker' || component.type === 'function') {
    for (const subscription of component.config.subscriptions) {
      relations.push(`⇐ ${subscription.bus} (subscribed)`);
    }
  }

  const envVars =
    component.bindings
      .map((binding) => {
        const resolved = resolveBinding(model, domain, binding);
        if (!resolved) return undefined;
        const qualified =
          resolved.domain.name === domain.name
            ? resolved.component.name
            : `${resolved.domain.name}-${resolved.component.name}`;
        return bindingEnvVarFor(resolved.component.type, qualified);
      })
      .filter((value): value is string => Boolean(value))
      .map((value) => `\`${value}\``)
      .join('<br>') || '—';

  return `| ${component.name} | ${badge} ${component.type} | ${relations.join('<br>') || '—'} | ${envVars} |`;
}

export function renderArchitectureMarkdown(model: WorkspaceModel): string {
  const lines: string[] = [];
  lines.push(`# ${model.name} — architecture`);
  lines.push('');
  lines.push('> Auto-generated by forge (`forge docs`). Manual edits will be overwritten.');
  lines.push('');
  lines.push(`**Engine:** ${model.engine} · **Default environment:** ${model.defaultEnvironment}`);
  lines.push('');

  lines.push('## Environments');
  lines.push('');
  lines.push('| Environment | Region | Account | Production |');
  lines.push('|---|---|---|---|');
  for (const [name, spec] of Object.entries(model.environments)) {
    const production = spec.production ?? name === 'prod';
    lines.push(`| ${name} | ${spec.region} | ${spec.account ?? '(current credentials)'} | ${production ? 'yes' : 'no'} |`);
  }
  lines.push('');

  lines.push('## Overview');
  lines.push('');
  lines.push('```mermaid');
  lines.push(renderArchitectureMermaid(model));
  lines.push('```');
  lines.push('');
  lines.push(
    'Arrows are **bindings**: least-privilege IAM access plus a discovery env var injected into the consumer. ' +
      'Modules are independent stacks — cross-module integration flows through events.',
  );
  lines.push('');

  for (const domain of model.domains) {
    lines.push(`## Module \`${domain.name}\``);
    lines.push('');
    if (domain.description) {
      lines.push(tableCell(domain.description));
      lines.push('');
    }
    lines.push(`Stack: \`${stackNameFor(model.name, domain.name, '<env>')}\``);
    lines.push('');
    if (domain.components.length === 0) {
      lines.push('_No components yet._');
    } else {
      lines.push('| Component | Type | Bindings | Injected env vars |');
      lines.push('|---|---|---|---|');
      for (const component of domain.components) {
        lines.push(componentRow(model, domain, component));
      }
    }
    lines.push('');
    lines.push(`Deploy: \`forge deploy ${domain.name} --env ${model.defaultEnvironment}\` · Test: \`forge test ${domain.name}\``);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
