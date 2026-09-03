import { resolveBinding } from './loader';
import type { AnyComponentSpec, ComponentSpec, DomainSpec, WorkspaceModel } from './model';
import { bindingEnvVarFor, stackNameFor } from './names';
import { packComponentDefinition } from './packs';
import type { PackComponentSpec } from './packs';

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
  gateway: '🚪',
  auth: '🔐',
  email: '✉️',
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
  gateway: { open: '[\\', close: '\\]' },
  auth: { open: '([', close: '])' },
  email: { open: '>', close: ']' },
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

function nodeFor(domain: DomainSpec, component: AnyComponentSpec): string {
  const id = mermaidId(domain.name, component.name);
  const packDocs = packComponentDefinition(component.type)?.docs;
  const shape = TYPE_SHAPES[component.type] ?? packDocs?.shape ?? { open: '[', close: ']' };
  const badge = TYPE_BADGES[component.type] ?? packDocs?.badge ?? '🧩';
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
    const everything = [...domain.components, ...(domain.packComponents ?? [])];
    if (everything.length === 0) {
      lines.push(`    ${mermaidId(domain.name, 'empty')}["(no components)"]`);
    }
    for (const component of everything) {
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
      if (component.type === 'http-api' && component.config.mount) {
        const resolved = resolveBinding(model, domain, component.config.mount);
        if (resolved) {
          const gw = mermaidId(resolved.domain.name, resolved.component.name);
          lines.push(`  ${gw} -.->${edgeLabel('routes')} ${from}`);
        }
      }
      if ((component.type === 'http-api' || component.type === 'gateway') && component.config.auth) {
        lines.push(`  ${from} -->${edgeLabel('auth')} ${mermaidId(domain.name, component.config.auth)}`);
      }
      if (component.type === 'static-site' && component.config.api) {
        lines.push(`  ${from} -->${edgeLabel('/api/*')} ${mermaidId(domain.name, component.config.api)}`);
      }
      if (component.type === 'static-site' && component.config.media) {
        lines.push(`  ${from} -->${edgeLabel('/media/*')} ${mermaidId(domain.name, component.config.media)}`);
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
  if (component.type === 'http-api' && component.config.mount) {
    relations.push(`⇒ ${component.config.mount} (mounted)`);
  }
  if ((component.type === 'http-api' || component.type === 'gateway') && component.config.auth) {
    relations.push(`→ ${component.config.auth} (authorizer)`);
  }
  if (component.type === 'static-site' && component.config.api) {
    relations.push(`⇒ ${component.config.api} (serves /api/*)`);
  }
  if (component.type === 'static-site' && component.config.media) {
    relations.push(`⇒ ${component.config.media} (serves /media/*)`);
  }
  if (
    (component.type === 'static-site' || component.type === 'gateway' || component.type === 'http-api') &&
    component.config.domain
  ) {
    relations.push(`🌐 ${component.config.domain.name}`);
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

function packComponentRow(component: PackComponentSpec): string {
  const badge = packComponentDefinition(component.type)?.docs?.badge ?? '🧩';
  return `| ${component.name} | ${badge} ${component.type} *(pack)* | — | — |`;
}

/**
 * AGENTS.md — machine-readable project knowledge for AI coding agents
 * (Claude Code, Cursor, Copilot, …). Regenerated with the docs, so an agent
 * always sees the real architecture plus the rules that keep it healthy.
 */
export function renderAgentGuide(model: WorkspaceModel): string {
  const lines: string[] = [];
  lines.push('# AGENTS.md — working on this forge workspace');
  lines.push('');
  lines.push('> Auto-generated by forge on every architecture change. Do not edit.');
  lines.push('');
  lines.push(
    `This is a **forge** workspace (engine: ${model.engine}): an Angular-style CLI owns the ` +
      'infrastructure architecture. Each module under `domains/` is a business domain deployed ' +
      'as an independent stack. Humans and agents change the ARCHITECTURE through forge ' +
      'commands, and write BUSINESS LOGIC in the generated hexagonal layout.',
  );
  lines.push('');
  lines.push('## Rules (violating these breaks the workspace)');
  lines.push('');
  lines.push('1. **Never hand-edit** `forge.json`, `domain.json`, `component.json`, generated');
  lines.push('   barrels (`src/infrastructure/controllers/index.ts`) or `docs/architecture.md`.');
  lines.push('   Use the commands: `forge generate module|component|endpoint`, `forge attach|detach`,');
  lines.push('   `forge remove module|component|endpoint`. They validate and roll back on error.');
  lines.push('2. **Business logic lives in `src/application/*.uc.ts`** (use cases). Controllers and');
  lines.push('   handlers are adapters — translation only. Ports go in `src/domain/ports/`,');
  lines.push('   implementations in `src/infrastructure/adapters/`.');
  lines.push('3. API routes in code must mirror `component.json` — `forge generate endpoint` keeps');
  lines.push('   them in sync; never add a route by hand.');
  lines.push('4. Cross-domain coupling ONLY through event buses (or gateway mounts). Never import');
  lines.push('   code or reference resources across `domains/*` directly.');
  lines.push('5. After changing architecture run `forge test <module> --update` (infra snapshots');
  lines.push('   change legitimately). All tests: `forge test`.');
  lines.push('6. Custom infra beyond forge types goes in `domains/<module>/extend.ts` (escape');
  lines.push('   hatch) or a component pack — never scattered raw IaC.');
  if (model.naming || model.tags) {
    lines.push('7. This workspace follows an ORG naming/tag contract (forge.json "naming"/"tags").');
    lines.push('   Physical names are a pure function of the model — never hand-tune them, and');
    lines.push('   never change "naming" on a deployed workspace: names are identity, changing');
    lines.push('   them REPLACES resources (stateful ones lose data).');
  }
  lines.push('');
  lines.push('## Current architecture');
  lines.push('');
  for (const domain of model.domains) {
    lines.push(`- **${domain.name}** (stack \`${stackNameFor(model.name, domain.name, '<env>')}\`)`);
    for (const component of domain.components) {
      const relations: string[] = component.bindings.map((b) => `→ ${b.component} (${b.access})`);
      if (component.type === 'queue-worker' || component.type === 'function') {
        for (const s of component.config.subscriptions) relations.push(`⇐ ${s.bus}`);
      }
      if (component.type === 'http-api' && component.config.mount) relations.push(`⇒ ${component.config.mount}`);
      if ((component.type === 'http-api' || component.type === 'gateway') && component.config.auth) {
        relations.push(`auth: ${component.config.auth}`);
      }
      if (component.type === 'static-site' && component.config.api) {
        relations.push(`serves ${component.config.api} at /api/*`);
      }
      if (component.type === 'static-site' && component.config.media) {
        relations.push(`serves ${component.config.media} at /media/*`);
      }
      if (
        (component.type === 'static-site' || component.type === 'gateway' || component.type === 'http-api') &&
        component.config.domain
      ) {
        relations.push(`domain: ${component.config.domain.name}`);
      }
      const detail = relations.length > 0 ? ` — ${relations.join(' · ')}` : '';
      lines.push(`  - \`${component.name}\` (${component.type})${detail}`);
      if (component.type === 'http-api') {
        for (const route of component.config.routes) {
          lines.push(`    - \`${route.method} ${route.path}\`${route.public ? ' (public)' : ''}`);
        }
      }
    }
    for (const component of domain.packComponents ?? []) {
      lines.push(`  - \`${component.name}\` (${component.type}, pack ${component.pack})`);
    }
  }
  lines.push('');
  lines.push('## Command cheat sheet');
  lines.push('');
  lines.push('```bash');
  lines.push('forge list                 # architecture overview');
  lines.push('forge g c <name> -m <mod> -t <type> [--bind t:access]   # new component');
  lines.push('forge g e <name> -m <mod> --method GET --route <path>   # new endpoint');
  lines.push('forge attach|detach <component> -m <mod> …              # manage couplings');
  lines.push('forge test [module] [--update]                          # verify');
  lines.push('forge deploy <module> -e <env>                          # ship one domain');
  lines.push('```');
  lines.push('');
  lines.push('Full reference: the forge repo docs (referencia-cli.md).');
  return `${lines.join('\n')}\n`;
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
    const packComponents = domain.packComponents ?? [];
    if (domain.components.length === 0 && packComponents.length === 0) {
      lines.push('_No components yet._');
    } else {
      lines.push('| Component | Type | Bindings | Injected env vars |');
      lines.push('|---|---|---|---|');
      for (const component of domain.components) {
        lines.push(componentRow(model, domain, component));
      }
      for (const component of packComponents) {
        lines.push(packComponentRow(component));
      }

      for (const component of domain.components) {
        if (component.type === 'http-api') {
          lines.push('');
          const suffix = component.config.mount ? ` *(mounted on \`${component.config.mount}\`)*` : '';
          lines.push(`**Endpoints of \`${component.name}\`**${suffix}:`);
          for (const route of component.config.routes) {
            lines.push(`- \`${route.method} ${route.path}\`${route.public ? ' — 🔓 public' : ''}`);
          }
        }
        if (component.type === 'gateway') {
          const mountedApis: string[] = [];
          for (const other of model.domains) {
            for (const candidate of other.components) {
              if (candidate.type !== 'http-api' || !candidate.config.mount) continue;
              const resolved = resolveBinding(model, other, candidate.config.mount);
              if (resolved?.domain.name === domain.name && resolved.component.name === component.name) {
                mountedApis.push(`${other.name}/${candidate.name}`);
              }
            }
          }
          if (mountedApis.length > 0) {
            lines.push('');
            lines.push(`**Gateway \`${component.name}\` publishes the routes of:** ${mountedApis.join(', ')}`);
          }
        }
      }
    }
    lines.push('');
    lines.push(`Deploy: \`forge deploy ${domain.name} --env ${model.defaultEnvironment}\` · Test: \`forge test ${domain.name}\``);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
