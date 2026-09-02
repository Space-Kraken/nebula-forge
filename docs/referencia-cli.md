# Referencia completa del CLI

Todos los comandos, args, flags y comportamientos de forge. Convenciones
globales primero; luego cada comando.

## Convenciones globales

- **Nombres**: siempre kebab-case (`user-events`). Referencias cross-domain:
  `dominio/componente` (solo válidas hacia `event-bus` y `gateway`).
- **Interactivo vs CI**: en terminal (TTY), lo que falte se pregunta; con
  `--no-interactive` o sin TTY (CI) nada pregunta y lo faltante es error.
  Todo prompt tiene su flag equivalente.
- **Transaccional**: si un paso falla, el comando revierte lo que escribió.
- **Docs vivas**: todo comando que cambia la arquitectura regenera
  `docs/architecture.md`.
- **Errores**: siempre `mensaje + pista (↳)`. La pista es la solución.
- **PowerShell**: rutas con `{}` van citadas → `--route '/users/{id}'`.

## Crear y explorar

### `forge new [nombre]`
Crea un workspace. Pregunta: nombre, credencial (perfil/subscription) y blueprint.

| Flag | Descripción |
|---|---|
| `-b, --blueprint <id>` | `serverless-api` · `queue-processing` · `scheduled-tasks` · `web-app` · `event-driven` |
| `--engine <id>` | `aws-cdk` (default) · `azure-terraform` |
| `--profile <p>` | Perfil AWS del toolchain (vacío = credenciales default) — solo aws-cdk |
| `--subscription <id>` | Subscription de Azure (vacío = la activa de `az login`) — solo azure-terraform |
| `--skip-install` | No instalar dependencias |
| `--no-interactive` | Sin prompts |
| `--link` | *(oculto, desarrollo)* deps `link:` al checkout de forge |

### `forge blueprints`
Lista las arquitecturas de referencia. Sin flags.

### `forge list`
Arquitectura del workspace en terminal: módulos, componentes y acoples
(`→` binding · `⇐` suscrito · `⇒` montado). Sin flags.

### `forge docs [--print]`
Regenera `docs/architecture.md` (Mermaid + tablas + endpoints por API).
`--print` imprime solo el diagrama.

## Generar (alias estilo Angular)

### `forge generate module [nombre]` — alias `g m`, `gm`
Nuevo dominio = stack independiente + test de infraestructura. Pregunta el
nombre si falta. Flags: `--no-interactive`.

### `forge generate component [nombre]` — alias `g c`, `gc`
Wizard completo en terminal: nombre → módulo → tipo → acoples inferidos.

| Flag | Descripción |
|---|---|
| `-m, --module <mod>` | Módulo dueño (se pregunta/deduce si hay uno solo) |
| `-t, --type <tipo>` | `function` · `http-api` · `queue-worker` · `table` · `bucket` · `topic` · `static-site` · `event-bus` · `gateway` · `auth` · `email` — más los tipos de los packs declarados en `forge.json` |
| `--bind <comp>:<acceso>` | El NUEVO componente usa a otro (repetible). Accesos: `read`, `write`, `read-write`, `publish`, `send` |
| `--attach <consumidor>:<acceso>` | Un componente EXISTENTE usa al nuevo (repetible; edita el manifest del consumidor) |
| `--subscribe <bus>:source=a,b[:detail-type=X]` | Suscribe el nuevo worker/función a un bus (repetible) |
| `--mount <gw>` | Monta el nuevo http-api en un gateway (`edge` o `platform/edge`) |
| `--auth <auth>` | Protege el nuevo gateway/http-api con un `auth` del mismo módulo |
| `--api <comp>` | Sirve un gateway/http-api del mismo módulo detrás del nuevo `static-site` en `/api/*` (mismo origen — sin CORS; se pregunta si hay candidatos) |
| `--cors <origenes>` | CORS en el nuevo gateway/http-api: `"*"` o lista separada por comas |
| `--domain <fqdn>` | Dominio propio (ACM + Route53) para `static-site`/`gateway`/`http-api`; requiere `--zone` |
| `--zone <id:nombre>` | Hosted zone de Route53 para `--domain` (ej. `Z0123456789:midominio.com`) |
| `--runtime <rt>` | `ts-fusion` (default AWS) · `ts` (hexagonal puro; default Azure) |
| `--partition-key <attr>` | Partition key para `table` (default `id`) |
| `--sort-key <attr>` | Sort key para `table` (opcional) |
| `--schedule <expr>` | Ejecuta la `function` en horario: `"rate(N unidad)"` o `"cron(m h dom mes dow año)"` — la expresión se valida al generar, no en el deploy |
| `--source-dir <dir>` | Carpeta del build a publicar en `static-site` (default `site/`; para frameworks que forge no inicializa, ej. Next con `out/`) |
| `--identity <id>` | Remitente para `email`: dirección o dominio (se pregunta si falta) |
| `--frontend <f>` | `none` · `vite` — inicializa frontend en `static-site` (se pregunta) |
| `--template <t>` | Template de Vite (`react-ts` default, `vue-ts`, `svelte-ts`, `vanilla-ts`…) |
| `--no-interactive` | Sin prompts |

Detalles: el `http-api` nace con endpoint `GET /status` (público; namespaceado
`/{módulo}/status` si está montado). Con `--frontend vite`, el frontend queda
en `app/` y `config.sourceDir` apunta a `app/dist` — compila antes de deploy.

### `forge generate endpoint [nombre]` — alias `g e`, `ge`
Acopla un endpoint al API del módulo: ruta + controller + use case + test,
siempre en sincronía (barrel regenerado por forge). Pregunta nombre, módulo,
método y ruta si faltan.

| Flag | Descripción |
|---|---|
| `-m, --module <mod>` | Módulo dueño (se pregunta/deduce) |
| `--method <M>` | `GET` · `POST` · `PUT` · `PATCH` · `DELETE` |
| `--route <r>` | Ruta (`/users/{id}`, greedy `{proxy+}` solo al final) — **citada en PowerShell** |
| `--api <comp>` | http-api dueño (se deduce si el módulo tiene uno) |
| `--public` | Sin authorizer (health checks, webhooks) |
| `--no-interactive` | Sin prompts |

Si el api está montado, avisa: la topología cambió → deploy del módulo **y**
del módulo del gateway.

## Acoplar y desacoplar

### `forge attach <componente> -m <módulo>`
Acopla un componente existente. Sin flags de acople → interactivo (ofrece lo
posible, excluyendo lo ya acoplado).

| Flag | Descripción |
|---|---|
| `--bind <comp>:<acceso>` | Binding nuevo (repetible) |
| `--subscribe <bus>:source=…[:detail-type=…]` | Suscripción nueva (repetible) |
| `--mount <gw>` | Montar http-api en gateway (si ya está montado: detach primero) |
| `--auth <auth>` | Proteger gateway/http-api |

### `forge detach <componente> -m <módulo>`
El inverso. Sin flags → checkbox con los acoples actuales.

| Flag | Descripción |
|---|---|
| `--bind <target>` | Quita ese binding (repetible) |
| `--subscribe <bus>` | Quita TODAS las suscripciones a ese bus (repetible) |
| `--mount` | Desmonta (vuelve a su propio API Gateway) |
| `--auth` | Quita el authorizer (las rutas quedan públicas) |

## Eliminar

Todos piden confirmación en terminal o `--yes` en scripts; se **niegan** si
algo referencia lo eliminado, y `--force` desacopla las referencias primero —
nunca queda una referencia colgante.

| Comando | Flags | Nota |
|---|---|---|
| `forge remove module <n>` | `--force`, `-y` | Borra el dominio completo; el stack desplegado sigue vivo (destrúyelo con el toolchain) |
| `forge remove component <n> -m <mod>` | `--force`, `-y` | |
| `forge remove endpoint <n> -m <mod>` | `--api`, `-y` | Protege el último endpoint (un api necesita ≥1 ruta) |

## Testear y desplegar

| Comando | Flags | Nota |
|---|---|---|
| `forge test [módulo]` | `-u, --update` | Unit + snapshot de infra; `--update` acepta cambios intencionales |
| `forge synth [módulo]` | `-e, --env` | CloudFormation / Terraform JSON, sin nube |
| `forge diff [módulo]` | `-e, --env` | Qué cambiaría el deploy |
| `forge deploy [módulo]` | `-e, --env`, `--all`, `-y` | Un dominio a la vez; `--all` explícito para todo; `-y` salta aprobaciones |
| `forge bootstrap` | `-e, --env` | AWS: `cdk bootstrap` · Azure: backend remoto de estado + migración. Idempotente |

## forge.json (referencia rápida)

```jsonc
{
  "name": "mi-app",
  "engine": "aws-cdk",              // o azure-terraform
  "defaultEnvironment": "dev",
  "defaults": { "runtime": "ts" },  // opcional: runtime por defecto
  "packs": ["forge-pack-secret"],   // opcional: component packs (npm o "./ruta.js")
  "environments": {
    "dev":  { "region": "us-east-1", "profile": "mi-perfil" },
    "prod": {
      "region": "us-east-1",
      "account": "111122223333",     // AWS: cuenta · Azure: subscription id
      "profile": "mi-perfil-prod",
      "production": true,            // retiene recursos con estado al borrar
      "state": { /* backend remoto: lo escribe forge bootstrap (Azure) */ }
    }
  }
}
```

## Chuleta

```bash
forge new mi-app --profile work           # workspace con credenciales
forge g m users                           # módulo
forge g c api -m users -t http-api --mount platform/edge
forge g e get-user -m users --method GET --route '/users/{id}'
forge attach api -m users --bind data:read-write
forge test users --update && forge deploy users -e dev
```
