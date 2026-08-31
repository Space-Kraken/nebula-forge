# forge — Modern Cloud Architecture Accelerator

CLI estilo Angular para construir soluciones AWS bien arquitecturadas sin ser
arquitecto. El CLI es dueño de la estructura, la organización y las buenas
prácticas de infraestructura; el equipo se concentra en la lógica de negocio.

```bash
forge new mi-app --blueprint queue-processing
cd mi-app
forge generate module payments
forge generate component api --module payments --type http-api
forge test payments
forge deploy payments --env dev
```

📖 **[Guía de uso](docs/guia-de-uso.md)** — el modelo mental (workspace →
módulos → componentes → acoples), el flujo completo y las convenciones.
🔧 **[Desarrollo local](docs/desarrollo-local.md)** — correr forge desde el
checkout, workspaces `--link` y ciclo de pruebas.
📚 **[Referencia del CLI](docs/referencia-cli.md)** — cada comando, cada flag,
alias (`g m`, `g c`, `g e`) y la chuleta.

## Por qué existe

- No todos los integrantes de un equipo dominan arquitectura AWS: backends
  excelentes terminan armando soluciones tricky o poco escalables.
- Los mega-stacks monolíticos obligan a testear y desplegar todo el sistema
  para cambiar algo mínimo. forge separa **un stack por dominio de negocio**:
  cada módulo se testea y despliega de forma independiente.
- Convención sobre configuración, como Angular: `new` y `generate` producen la
  estructura correcta; nadie decide dónde va cada cosa.

## Conceptos

| Concepto | Qué es | En AWS |
|---|---|---|
| **Workspace** | El proyecto (`forge.json`: motor + entornos) | — |
| **Módulo (dominio)** | Un dominio de negocio, aislado y desplegable | 1 stack de CloudFormation por entorno |
| **Componente** | Una pieza de arquitectura dentro del módulo | `http-api`, `queue-worker`, `function`, `table`, `bucket`, `topic`, `static-site`, `event-bus`, `gateway`, `auth`, `email` |
| **Binding** | Dependencia declarada entre componentes | IAM de mínimo privilegio + env vars de descubrimiento (`TABLE_X_NAME`, `QUEUE_X_URL`) |
| **Blueprint** | Arquitectura de referencia completa | `serverless-api`, `queue-processing`, `scheduled-tasks`, `web-app`, `event-driven` |

Los bindings **no cruzan dominios**, con una única excepción: los `event-bus`
(EventBridge). Un dominio publica a `otro-dominio/bus` y un `queue-worker` (o
una `function`, para reacciones ligeras sin DLQ) se suscribe con
`subscriptions` en su manifest — el bus se referencia por **nombre
determinístico**, sin exports de CloudFormation, así cada stack sigue
desplegándose por separado. `static-site` entrega S3 privado + CloudFront (SPA
fallback, WAF opcional, dominio propio con ACM + Route53, y `config.api` para
servir el API del módulo detrás de la misma distribución en `/api/*` — mismo
origen, sin CORS). Los gateways/http-apis aceptan CORS explícito y dominio
custom regional cuando sí hay orígenes externos.

La convención para APIs es **una Lambda por dominio**: un componente
`http-api` por módulo, y fusion rutea los controllers de ese dominio dentro de
la Lambda — por eso las Lambdas son hexagonales. ¿Un solo API para todo el
proyecto? Crea un `gateway` compartido y monta los `http-api` con `--mount
platform/edge`: el gateway publica la unión de rutas integrando cada Lambda
por nombre determinístico (1 API para N dominios, N APIs, o mixto).

### Buenas prácticas incorporadas

Cada componente sale de fábrica con lo que un arquitecto exigiría: colas con
DLQ y reintentos parciales (`reportBatchItemFailures`), DynamoDB on-demand con
point-in-time recovery, S3 cifrado/bloqueado/SSL-only, X-Ray activo, Lambdas
ARM64 en Node 24, retención de recursos con estado en producción y tags de
app/dominio/entorno en todo.

### Lambdas: hexagonal + fusion

Las Lambdas TypeScript generadas siguen **arquitectura hexagonal** sobre
[@fusion-framework/server](https://github.com/acyclicstudent/fusion-server):

- `src/handler.ts` — composition root (solo wiring)
- `src/application/` — use cases (`@UseCase()` + `UCExecutor`): la lógica de negocio
- `src/domain/ports/` — puertos (interfaces) de los que depende el negocio
- `src/infrastructure/` — adaptadores: controllers/handlers de entrada, repositorios de salida

Notas técnicas (verificadas contra fusion 1.4.1):
- fusion rutea HTTP por coincidencia exacta `httpMethod + resource` → el motor
  genera **API Gateway REST (payload v1)** con un resource por ruta declarada
  en `component.json`.
- La inyección debe usar tokens explícitos (`@Executor()`, `@Inject('token')`):
  esbuild no emite decorator metadata.
- Los workers SQS usan un adaptador generado por forge (no el pipeline de
  listeners de fusion, que captura errores y confirmaría mensajes fallidos);
  la lógica sigue en use cases de fusion.

### Acoples inferidos

Al generar un recurso en una terminal, el CLI mira el workspace e **infiere a
qué se puede acoplar**: crear una tabla pregunta qué componentes la usarán
(edita el manifest del consumidor), crear una lambda pregunta a qué recursos
se conecta, y crear un worker o función ofrece suscribirla a un bus de
eventos. Cada respuesta tiene su flag equivalente (`--attach api:read-write`,
`--subscribe platform/events:source=orders`), así que en CI nada pregunta.
Los endpoints se acoplan con `forge generate endpoint`: los controllers viven
en un barrel generado (`src/infrastructure/controllers/index.ts`) que forge
reescribe — nunca edita código a mano.

El ciclo de vida completo se gestiona después de crear: `forge attach` /
`forge detach` agregan o quitan acoples de componentes existentes (con
validación y rollback sobre los manifests), y `forge remove component|endpoint`
elimina piezas — negándose mientras otros componentes las usen, o
desacoplándolas primero con `--force`, para que nunca quede una referencia
colgante.

### Documentación viva (para humanos y para IAs)

`forge docs` genera `docs/architecture.md` con un diagrama Mermaid del
workspace (dominios como subgrafos, componentes tipados, bindings como
flechas) y una tabla por módulo con sus env vars inyectadas — y `AGENTS.md`
en la raíz: las reglas del workspace, la arquitectura actual y la chuleta de
comandos en el formato que leen Claude Code, Cursor y Copilot, para que
cualquier IA sepa cómo trabajar el proyecto sin romperlo. Ambos se regeneran
automáticamente con cada `forge new` / `forge generate`, así nunca mienten.
Mermaid renderiza nativo en GitHub/GitLab.

### Extensibilidad: escape hatch y packs

Cuando forge no modela algo, no lo abandonas: `domains/<módulo>/extend.ts`
recibe el stack del dominio (o el documento Terraform en Azure) y ahí escribes
CDK/TF crudo, dentro de las mismas fronteras de dominio. Y cuando ese algo es
reutilizable, se convierte en un **component pack**: un paquete npm que agrega
tipos de componente nuevos (`forge.json` → `"packs": [...]`) con schema
validado, bindings de mínimo privilegio, scaffolding y presencia en docs —
como el Steam Workshop, pero de arquitectura. Ejemplo completo en
`examples/forge-pack-secret/`.

### Testing por dominio

Los componentes que ejecutan código (`function`, `http-api`, `queue-worker`)
nacen con test unitario, y cada módulo con un snapshot test de su template de
CloudFormation. `forge test payments` corre solo ese dominio; cuando cambias
la infraestructura a propósito, `forge test payments --update` acepta el nuevo
snapshot.

## Multi-cloud: Azure (beta)

El mismo modelo, otro motor: `forge new mi-app --engine azure-terraform`
genera un workspace cuyo `forge synth/diff/deploy` produce **Terraform JSON**
(un root module por dominio, estado independiente) y ejecuta el binario de
`terraform` por ti — tu equipo nunca escribe ni lee HCL.

| Modelo | Azure |
|---|---|
| módulo | Resource Group + estado Terraform propio |
| `function` / `queue-worker` | Function Apps (Node 20, zip empaquetado por forge) / Service Bus queue + DLQ |
| `table` / `bucket` / `topic` | Cosmos DB serverless / Blob container / Service Bus topic |
| `event-bus` | Event Grid topic por nombre determinístico (cross-domain sin estado compartido) |
| bindings | Managed identity + RBAC de mínimo privilegio + app settings de descubrimiento |

Aún no en Azure: `http-api` (llega con fusion-azure) y `static-site` (Front
Door) — el CLI los rechaza con un error claro. Para equipos:
`forge bootstrap` provisiona el backend remoto de estado (storage account
determinístico), lo registra en `forge.json` y migra el estado local.

## Estructura del monorepo

```
packages/
  core/             Modelo agnóstico: manifiestos, validación (zod), loader, contrato Engine
  engine-cdk/       Motor AWS CDK: DomainStack, builders por tipo, bindings → IAM
  engine-azure-tf/  Motor Azure: Terraform JSON puro, RBAC, Event Grid, empaquetado de Functions
  blueprints/       Arquitecturas de referencia
  cli/              oclif: new, generate, attach/detach/remove, docs, test, synth, diff, deploy
```

`core` no conoce CDK: define el modelo (workspace → dominios → componentes →
bindings) y el contrato `Engine`. `engine-cdk` es la primera implementación;
otros motores (otras nubes) implementan el mismo contrato — ese es el camino
multi-cloud.

## Desarrollo

```bash
pnpm install
pnpm run build        # tsc -b con project references
pnpm test             # tests de core y engine-cdk

# Probar el CLI contra el checkout local (deps link:)
node packages/cli/bin/run.js new demo --blueprint queue-processing --link
```

## Comandos

| Comando | Descripción |
|---|---|
| `forge new <nombre> [--blueprint <id>] [--engine …] [--profile <aws>\|--subscription <az>]` | Crea un workspace; pregunta credenciales en terminal (vacío = default) |
| `forge blueprints` | Lista las arquitecturas de referencia |
| `forge generate module <nombre>` | Nuevo dominio (stack independiente) |
| `forge generate component <n> -m <mod> -t <tipo>` | Nuevo componente; en terminal **infiere los acoples y pregunta** (a quién se conecta, quién lo usa, a qué bus se suscribe). Flags para CI: `--bind`, `--attach`, `--subscribe`, `--no-interactive` |
| `forge generate endpoint <n> -m <mod> [--method GET --route /x/{id}]` | Acopla un endpoint a la Lambda del dominio: ruta en API Gateway + controller fusion + use case + test, siempre en sincronía |
| `forge attach <comp> -m <mod> [--bind t:acceso] [--subscribe bus:…]` | Acopla un componente **existente** (interactivo sin flags) |
| `forge detach <comp> -m <mod> [--bind t] [--subscribe bus]` | Desacopla bindings/suscripciones (interactivo: checkbox de acoples actuales) |
| `forge remove module\|component\|endpoint <n> [--force]` | Elimina piezas; se niega si algo las usa (`--force` desacopla primero) |
| `forge remove endpoint <n> -m <mod>` | Elimina un endpoint: ruta + controller + use case + test + barrel |
| `forge list` | Muestra la arquitectura del workspace |
| `forge docs [--print]` | Genera `docs/architecture.md` (diagrama Mermaid + tablas); se regenera solo con cada `new`/`generate` |
| `forge test [módulo]` | Tests unitarios + de infraestructura |
| `forge synth [módulo] [-e env]` | Genera CloudFormation |
| `forge diff [módulo] [-e env]` | Qué cambiaría un deploy |
| `forge deploy <módulo> [-e env]` | Despliega un dominio (`--all` para todos, explícito) |
| `forge bootstrap [-e env]` | Prepara el entorno: `cdk bootstrap` (AWS) o backend remoto de estado + migración (Azure). Idempotente |

## Roadmap

- [ ] Publicar `@forgecli/*` en npm
- [ ] Azure 1b: `http-api` con fusion-azure, `static-site` con Front Door, Entra External ID, ACS email
- [ ] Frontend en repo separado del backend (multi-repo: workspaces front/back independientes que se referencian) — diseño pendiente
- [ ] `state-machine` (Step Functions) para orquestación
- [ ] `service` (ECS) para microservicios donde Lambda no alcanza, y soporte de VPCs custom
- [ ] Contratos tipados para eventos entre dominios
- [ ] Pipeline CI/CD generado (deploy por dominio)
- [ ] Segundo motor (otra nube) sobre el mismo modelo
