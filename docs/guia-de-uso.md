# Guía de uso de forge

forge es a la infraestructura lo que Angular CLI o Vite son al frontend: tú
pides las piezas (`new`, `generate`) y el CLI es dueño de la estructura, las
buenas prácticas y el cableado. Tú escribes lógica de negocio.

## 1. El modelo mental

```
🧰 workspace ──────────────── el proyecto (forge new)
├── 📦 users ──────────────── módulo = dominio de negocio = stack propio
│   ├── 🌐 api ────────────── http-api: la lambda del dominio y sus endpoints
│   ├── 🗄️ data ───────────── table
│   └── ✉️ notifications ──── email
├── 📦 orders
│   ├── 🌐 api
│   ├── ⚙️ worker ─────────── queue-worker (cola + DLQ)
│   └── 🪣 files ──────────── bucket
└── 📦 platform ───────────── lo (poco) legítimamente compartido
    ├── 🚪 edge ───────────── gateway: el API general donde se montan dominios
    ├── 🔐 identity ───────── auth: protege el gateway
    └── 🚌 events ─────────── event-bus: eventos entre dominios

acoples:  api ─→ data (read-write) · api ─→ notifications (send)
          api ⇒ platform/edge (montado) · worker ⇐ platform/events (suscrito)
```

*(El diagrama detallado de TU workspace vive en `docs/architecture.md`,
regenerado por forge en cada cambio — ese sí en Mermaid, que GitHub/GitLab
renderizan nativo.)*

| Concepto | Analogía frontend | Qué es en forge |
|---|---|---|
| **Workspace** | el proyecto de Vite/Angular | Carpeta creada por `forge new`: manifiesto (`forge.json`), dominios, toolchain lista |
| **Módulo** | `ng generate module` | Un **dominio de negocio** (`users`, `orders`, `billing`). Cada uno se despliega como stack independiente |
| **Componente** | `ng generate component` | Una pieza de arquitectura dentro del dominio: API, worker, tabla, bucket, bus… |
| **Endpoint** | una ruta + controller | Ruta de API + controller + use case + test, acoplados a la lambda API del dominio |
| **Acople** | inyección de dependencias | Binding (IAM mínimo + env var) o suscripción a eventos, declarado — nunca cableado a mano |

**La regla de oro:** un módulo es un *dominio de negocio*, no una capa técnica.
Cada dominio con API tiene **su propia** lambda (`api`) con **sus** endpoints —
así `forge deploy users` jamás toca `orders`. Lo único legítimamente
compartido es el **event-bus** (típicamente en un módulo `platform`): los
dominios publican y se suscriben a él por nombre, sin acoplarse entre sí.

> ❌ `forge generate module shared` con "el API base" de todos
> ✔️ `forge generate module platform` con el `event-bus` compartido
> ✔️ un `http-api` llamado `api` **dentro de cada dominio** que exponga rutas
>
> ¿Y un API *general* con dominios colgados por path? Para eso existe el tipo
> `gateway` — ver §9.

## 2. Crear un proyecto

```bash
forge new mi-app                          # interactivo: pregunta perfil AWS y blueprint
forge new mi-app --blueprint event-driven # o directo desde una arquitectura de referencia
forge new mi-app --profile mi-empresa     # perfil AWS del toolchain (vacío = default)
forge new mi-app --engine azure-terraform --subscription <id>  # Azure (vacío = az account actual)
cd mi-app                                 # deps ya instaladas (pnpm)
```

Las credenciales quedan en `forge.json` por **entorno**
(`environments.<env>.profile` en AWS, `.account` = subscription en Azure), así
dev y prod pueden usar cuentas distintas — el setup inicial las aplica a
todos y las afinas ahí. `deploy/diff/bootstrap` las honran automáticamente
(`AWS_PROFILE` / `az --subscription` / `subscription_id` de terraform).

Blueprints disponibles (`forge blueprints`): `serverless-api`,
`queue-processing`, `scheduled-tasks`, `web-app`, `event-driven`.

## 3. Módulos y componentes

```bash
forge generate module users
forge generate component api --module users --type http-api
forge generate component data --module users --type table --partition-key userId
```

En una terminal, forge **infiere los acoples y pregunta** ("¿qué componentes
usarán `data`?"); cada pregunta tiene su flag gemelo para scripts/CI:

```bash
forge generate component data --module users --type table --attach api:read-write --no-interactive
```

Tipos de componente y a qué se traducen:

| Tipo | AWS | Azure |
|---|---|---|
| `http-api` | API Gateway REST + Lambda (fusion) | *(fase 1b — llega con fusion-azure)* |
| `function` | Lambda (+ schedule, + eventos) | Function App (+ timer, + Event Grid) |
| `queue-worker` | SQS + DLQ + Lambda | Service Bus queue + DLQ + Function App |
| `table` | DynamoDB on-demand | Cosmos DB serverless |
| `bucket` | S3 privado y cifrado | Blob container |
| `topic` | SNS | Service Bus topic |
| `event-bus` | EventBridge | Event Grid topic |
| `gateway` | API Gateway REST compartido (ver §9) | *(fase 1b — APIM/Front Door)* |
| `auth` | Cognito User Pool + client (ver §9) | *(fase 1b — Entra External ID)* |
| `email` | Identidad SES (dirección o dominio) | *(fase 1b — Communication Services)* |
| `static-site` | S3 + CloudFront (+WAF) | *(fase 1b — Front Door)* |

### Runtimes: fusion es opcional

La arquitectura hexagonal es el invariante de forge; el framework no. Los
componentes con código aceptan `--runtime`:

- **`ts-fusion`** (default en AWS): TypeScript sobre
  `@fusion-framework/server` — decoradores, DI, controllers fusion.
- **`ts`**: TypeScript hexagonal puro, sin framework — mismos layouts, mismos
  endpoints, y en `http-api` un mini-router generado por forge con el mismo
  matching exacto `httpMethod + resource`. Es el default en Azure (hasta
  fusion-azure).

El default por workspace se fija en `forge.json` → `defaults.runtime`, y se
puede mezclar por componente. Próximos: más lenguajes (python/go).

## 4. Endpoints (el API de cada dominio)

```bash
forge generate endpoint get-user --module users --method GET --route /users/{id}
forge generate endpoint create-user --module users --method POST --route /users
```

Cada endpoint genera y mantiene en sincronía: la **ruta en API Gateway**
(`component.json`), un **controller** fusion (adaptador — solo traducción), un
**use case** (`src/application/<nombre>.uc.ts` — **aquí va tu lógica**) y un
**test**. Los controllers se registran en un barrel que forge regenera; nunca
edita tu código a mano.

```
domains/users/components/api/
  src/
    handler.ts                      # composition root (no tocar lógica aquí)
    application/get-user.uc.ts      # 👈 tu lógica de negocio
    domain/ports/                   # interfaces que tu lógica necesita
    infrastructure/
      controllers/get-user.controller.ts
      adapters/                     # implementaciones reales de los ports
```

## 5. Acoples: bindings y eventos

**Bindings** (mismo dominio): acceso de mínimo privilegio + variable de
descubrimiento inyectada al consumidor.

```bash
forge attach api --module users --bind data:read-write
# → IAM/RBAC mínimo + process.env.TABLE_DATA_NAME en la lambda api
```

Accesos: `read`, `write`, `read-write` (tablas/buckets) · `publish`
(colas/topics/buses) · `send` (email — otorga `ses:SendEmail` mínimo e
inyecta `EMAIL_<NOMBRE>_FROM` con la identidad remitente).

Para `email`: `--identity no-reply@app.com` (o un dominio — los CNAMEs DKIM
salen como outputs del deploy). Ojo: SES arranca en *sandbox* (solo envía a
direcciones verificadas) hasta pedir production access en la consola.

**Eventos** (entre dominios): la ÚNICA forma de cruzar dominios es un
`event-bus`, referenciado como `dominio/bus`:

```bash
# orders publica; billing reacciona desde su propia cola
forge attach api --module orders --bind platform/events:publish
forge generate component processor --module billing --type queue-worker \
  --subscribe platform/events:source=orders
```

`queue-worker` para procesamiento confiable (retries + DLQ); `function`
suscrita para reacciones ligeras sin DLQ.

**Ciclo de vida completo:**

```bash
forge attach <comp> -m <mod>        # acoplar (interactivo sin flags)
forge detach <comp> -m <mod>        # desacoplar (checkbox de acoples actuales)
forge remove endpoint get-user -m users
forge remove component data -m users          # se niega si alguien la usa
forge remove component data -m users --force  # desacopla referentes primero
```

## 6. Ver, testear, desplegar

```bash
forge list                    # arquitectura en la terminal
forge docs                    # regenera docs/architecture.md (Mermaid) — también
                              #   se actualiza solo con cada new/generate/attach
forge test users              # unit tests + snapshot de infraestructura del dominio
forge test users --update     # aceptar un cambio de infra intencional
forge diff users --env dev    # qué cambiaría
forge deploy users --env dev  # despliega SOLO ese dominio
forge deploy --all --env dev  # todo, solo si lo pides explícito
```

Requisitos por motor (una vez por entorno, con `forge bootstrap`):
- **aws-cdk**: credenciales AWS y `forge bootstrap` (envuelve `cdk bootstrap`).
- **azure-terraform**: binario `terraform` + `az login`, y `forge bootstrap`:
  crea el backend de estado compartido (storage account determinístico), lo
  registra en `forge.json` y migra el estado local de cada dominio. Sin
  bootstrap el estado es local (`.tfstate/`) — suficiente para probar solo,
  no para trabajar en equipo. Es idempotente: repetirlo no rompe nada.

## 7. Convenciones que te ahorran problemas

- Nombres **kebab-case** (`user-events`, no `userEvents`).
- Un `http-api` por dominio, llamado `api`. Las rutas crecen con
  `generate endpoint`, no creando más APIs.
- Variables de ruta consistentes: si ya existe `/users/{id}`, no crees
  `/users/{userId}` (forge lo rechaza — API Gateway no lo permite).
- La lógica vive en `application/`; los adaptadores (`infrastructure/`) solo
  traducen. Si tu use case necesita el mundo exterior, defínele un port.
- No edites `component.json` para cosas que un comando hace mejor: el comando
  valida y hace rollback si algo queda inválido.

## 8. Problemas comunes

| Síntoma | Causa | Solución |
|---|---|---|
| `Snapshots 1 failed` tras generar algo | El template de infra cambió (esperado) | `forge test <mod> --update` |
| `Multiple modules found…` al deploy | Protección anti-"deploy todo sin querer" | Nombra el módulo o pasa `--all` |
| `Component … is still used by…` al remove | Otros componentes lo referencian | `forge detach` primero o `--force` |
| `Terraform CLI not found` | Falta el binario (Azure) | Instálalo; forge lo maneja desde ahí |
| `no prompts en CI` | Diseñado así (sin TTY no pregunta) | Usa los flags `--bind/--attach/--subscribe` |
| Error con pista `↳` | Todo error de forge trae su cómo-arreglarlo | Léela: es la solución |
| `Nonexistent flags: -encodedCommand…` | PowerShell trata `{id}` como script block | Cita la ruta: `--route '/users/{id}'` |

## 9. Gateway compartido: un API para N dominios

En muchos proyectos el API es **uno solo** (una URL, un dominio custom) y los
dominios cuelgan de él por path. Para eso existe el tipo `gateway` — la
recepción del edificio: una sola dirección, el guardia (futuro authorizer) y
el directorio de pisos. **Ahí no trabaja nadie**; quien atiende es el
`http-api` de cada dominio.

| | `gateway` | `http-api` |
|---|---|---|
| Qué es | Solo el borde: API Gateway compartido | La Lambda del dominio + sus endpoints |
| Código tuyo | ❌ nunca | ✔️ controllers, use cases, tests |
| `generate endpoint` | ❌ | ✔️ siempre aquí |
| Dueño de la URL | ✔️ (y futuro: custom domain, authorizer) | Solo si NO está montado |
| Se redespliega cuando… | cambia la *topología* de rutas | cambia tu *código* |

```bash
# la recepción, una vez, en platform:
forge generate component gateway --module platform --type gateway
# la oficina de users, montada en la recepción (sin puerta propia):
forge generate component api --module users --type http-api --mount platform/gateway
# los endpoints van SIEMPRE al http-api:
forge generate endpoint get-user --module users --method GET --route /users/{id}
```

Sin `--mount`, el `http-api` provisiona su propio API Gateway (dominio 100%
autónomo). Con él, el gateway materializa la unión de rutas de todos los
montados integrando cada Lambda por nombre determinístico — sin exports entre
stacks, mismo truco que el event-bus. Flexibilidad total: 1 API para N
dominios, N APIs, o mixto — y se cambia después con
`forge attach api -m users --mount platform/edge` / `forge detach … --mount`.

Detalles que forge cuida por ti:
- El endpoint inicial de un api **montado** nace namespaceado
  (`/users/status`), así N dominios nunca colisionan en el gateway.
- Rutas duplicadas o variables hermanas distintas **entre dominios** del mismo
  gateway se rechazan al generar, con el nombre de ambos dueños.
- Al agregar endpoints en un api montado, forge avisa: *"Route topology
  changed — deploy users AND the gateway's module"*. Trade-off asumido:
  cambiar rutas redespliega también el módulo del gateway (los deploys de
  *código* siguen 100% independientes).
- `forge remove component` del gateway se niega mientras haya apis montados
  (`--force` los desmonta primero).

Regla mnemotécnica: **si tiene endpoints es `http-api`; si tiene la URL es
`gateway`.**

### Autenticación: el guardia de la recepción

El tipo `auth` (Cognito User Pool + app client, con outputs de UserPoolId y
ClientId para el frontend) se acopla al gateway — o a un `http-api` no
montado — **del mismo módulo** (los pool ids no son determinísticos, así que
conviven en el stack):

```bash
forge generate component identity --module platform --type auth
forge attach edge --module platform --auth identity     # protege TODO el gateway
forge generate endpoint health --module users --method GET --route /users/health --public
```

Con auth acoplado, toda ruta exige un JWT del pool salvo las marcadas
`--public` (los `/status` generados nacen públicos — health checks). Los
claims llegan al handler en `event.requestContext.authorizer.claims`.
`forge detach edge -m platform --auth` lo quita; eliminar el `auth` exige
desacoplarlo primero (o `--force`).
