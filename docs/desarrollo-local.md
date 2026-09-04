# Mini-guía: correr forge en local (para probar y desarrollar)

Cómo usar forge desde el checkout del repo, sin publicar nada en npm.

## Requisitos

- Node 20+, pnpm, git.
- Solo para deploys reales: credenciales AWS + `cdk bootstrap` (motor
  aws-cdk), o binario `terraform` + `az login` (motor azure-terraform).
  Synth y tests no necesitan nube.

## Preparar el repo

```bash
git clone https://github.com/Space-Kraken/forge.git
cd forge
pnpm install
pnpm run build     # tsc -b de todos los paquetes
pnpm test          # suite completa (los tests de engine-cdk tardan unos segundos)
```

## Ejecutar el CLI

Directo desde el repo:

```bash
node <ruta-al-repo>/packages/cli/bin/run.js <comando>
```

Cómodo: crea un alias `forge` (PowerShell → `$PROFILE`, bash → `~/.bashrc`):

```powershell
function forge { node D:\Projects\forge\packages\cli\bin\run.js @args }
```

```bash
alias forge='node ~/forge/packages/cli/bin/run.js'
```

## Workspace de prueba con `--link`

Los workspaces generados dependen de `@space-kraken/nebula-forge-core` y del motor. Como aún
no están publicados en npm, `pnpm install` no tendría de dónde sacarlos — el
flag (oculto) `--link` lo resuelve escribiendo las dependencias como
**symlinks a tu checkout**:

```jsonc
// sin --link (cuando publiquemos):   "@space-kraken/nebula-forge-core": "^0.1.0"
// con --link (hoy):                  "@space-kraken/nebula-forge-core": "link:<tu-repo>/packages/core"
```

Consecuencias: (1) no hace falta publicar nada; (2) al compilar el repo
(`pnpm run build`), TODOS los workspaces linkeados ven el código nuevo al
instante — es la misma carpeta, no una copia; (3) la ruta es absoluta a tu
disco, así que un workspace `--link` **no es portable** a otra máquina — por
eso el flag es solo de desarrollo. (Se usa `link:` y no `file:` porque los
paquetes se referencian con `workspace:^`, que solo resuelve dentro del
monorepo.)

Hoy, **todo** workspace que quieras instalar/probar necesita `--link`; cuando
`@space-kraken/nebula-forge-*` esté en npm, será solo para probar cambios de forge sin
release:

```bash
cd ~/pruebas                      # fuera del repo
forge new demo --blueprint event-driven --link
cd demo && pnpm install
forge test                        # unit + snapshots de infra, sin nube
forge synth                       # CloudFormation/Terraform en local
```

## Ciclo de desarrollo

1. Cambia código en `packages/*` del repo.
2. `pnpm run build` en el repo (los workspaces `--link` ven el `dist/` nuevo).
3. Re-ejecuta `forge test` / `forge synth` en el workspace de prueba.
4. Snapshot de infra cambió a propósito → `forge test <módulo> --update`.

## Deploy real de prueba (y limpieza)

```bash
forge diff orders --env dev       # revisa antes
forge deploy orders --env dev
```

Para destruir lo desplegado (forge aún no tiene `destroy`):

- **AWS**: dentro del workspace, `npx cdk destroy <stack> ` (el stack se llama
  `<app>-<módulo>-<env>`; recuerda `$env:FORGE_ENV`/`FORGE_ENV=dev`).
- **Azure**: `terraform -chdir=.forge/azure/dev/<módulo> destroy` — o borra el
  resource group `rg-<app>-<módulo>-dev` desde el portal (todo el dominio vive
  ahí).

## Tips

- Los demos generados no van dentro del repo (mantén `~/pruebas` aparte).
- `pnpm --filter @space-kraken/nebula-forge-engine-cdk run test` para iterar un solo paquete.
- El primer synth AWS tarda más (bundling esbuild de cada Lambda); los
  siguientes usan caché de assets.
