# Servidor MCP de Smart University, Kunna

Servidor [MCP (Model Context Protocol)](https://modelcontextprotocol.io) que expone datos IoT del campus de la **Universidad de Alicante** (consumo eléctrico, agua, meteorología, sensores ambientales de aulas y WiFi), junto con búsqueda semántica de edificios y prompts listos para generar informes.

La idea: en lugar de hablar con la API de medición a pelo, un modelo conectado a este servidor puede resolver consultas como *"dame el informe de consumo eléctrico de la poli en junio"* o *"¿hay alguna fuga de agua en derecho?"* encadenando las herramientas que se exponen aquí.

> Este repositorio es parte de un Trabajo de Fin de Grado (TFG). Existe también un cliente desarrollado para completar el ciclo de desarrollo de la arquitectura MCP: [`https://github.com/vancovx/KunnaClienteMCP`](#).


## ¿Qué hace este servidor?

- **Consulta datos de medición** de varias colecciones IoT (energía, agua, clima, sensores de sala, WiFi) a través de la API de Kunna: lecturas crudas, agregados por hora/día, máximos, mínimos, sumas, etc.
- **Genera informes** mediante *prompts* predefinidos: consumo eléctrico mensual, consumo de agua con detección de fugas y confort ambiental de un aula.
- **Resuelve edificios en lenguaje natural.** Entiende código SIGUA (`0025`), nombre oficial (`Escuela Politécnica Superior I`) o descripción libre (`la poli`, `donde se imparte enfermería`) y lo traduce al edificio correcto usando embeddings.
- Todo ello sobre **Streamable HTTP**, con sesiones, autenticación por token, rate limiting y logging estructurado.

## Stack

| Pieza | Tecnología |
|---|---|
| Runtime | Node.js (ESM) |
| HTTP | Express |
| Protocolo | `@modelcontextprotocol/sdk` (transporte Streamable HTTP) |
| Base de datos | PostgreSQL + [pgvector](https://github.com/pgvector/pgvector) |
| Embeddings | `@xenova/transformers` · modelo `paraphrase-multilingual-mpnet-base-v2` (768 dim) |
| Cliente API externa | axios |
| Fechas/zonas horarias | luxon |
| Validación | zod |
| Logging | pino + pino-pretty |
| Seguridad | helmet · cors · express-rate-limit |

---

## Estructura del proyecto

```
.
├── index.js                          # Punto de entrada: arranca el servidor
├── data/
│   ├── buildings/                    # GeoJSON crudos, uno por edificio (entrada)
│   └── edificios.json                # Edificios ya fusionados (salida de mergeBuildings)
└── src/
    ├── server.js                     # Servidor Express + MCP: rutas /mcp y /health, sesiones
    ├── SessionManager.js             # Ciclo de vida de sesiones MCP y streams SSE (heartbeat, TTL, limpieza)
    │
    ├── config/
    │   └── logger.js                 # Logger pino (bonito en dev, JSON plano en prod; redacta secretos)
    │
    ├── middleware/
    │   ├── auth.js                   # Autenticación Bearer (se desactiva en development)
    │   ├── security.js               # Cabeceras seguras, CORS restringido y rate limit
    │   └── acceptValidation.js       # Valida los headers Accept que exige la spec MCP
    │
    ├── tools/
    │   ├── registerTool.js           # Tools de datos: discover-collection, get-device-details, query-data, query-aggregation
    │   └── campusTool.js             # Tool search-campus-buildings (SIGUA + búsqueda semántica)
    │
    ├── prompts/
    │   └── registerPrompts.js        # Prompts de informes: electricidad, agua y confort de aula
    │
    ├── services/
    │   ├── measurements.service.js   # Cliente de la API Kunna (info, dispositivos, query, agregación)
    │   └── embeddings.service.js     # Generación de embeddings + acceso a PostgreSQL/pgvector
    │
    └── scripts/
        ├── mergeBuildings.js         # Fusiona los GeoJSON de data/buildings en edificios.json
        ├── loadBuildings.js          # Carga edificios.json en la BD y genera sus embeddings
        └── test-embeddings-buildings.js  # Prueba rápida de la búsqueda semántica
```

**Resumen de carpetas:**

- **`data/`** — los datos geográficos de los edificios. Pones los GeoJSON en `buildings/`, los fusionas y obtienes `edificios.json`, que es lo que se carga a la base de datos.
- **`src/config/`** — configuración del logger.
- **`src/middleware/`** — todo lo que se ejecuta *antes* de llegar a la lógica MCP: seguridad, autenticación y validación de la petición.
- **`src/tools/`** — las herramientas que el modelo puede invocar. Lo que el cliente realmente "llama".
- **`src/prompts/`** — plantillas de instrucciones reutilizables que orquestan varias tools para producir un informe completo.
- **`src/services/`** — la lógica que habla con el mundo exterior: la API de Kunna y la base de datos de embeddings.
- **`src/scripts/`** — utilidades que se lanzan a mano (no forman parte del servidor en ejecución).

---

## Requisitos

- Node.js (versión con soporte de ESM y *top-level await*, p. ej. 18+).
- PostgreSQL con la extensión **pgvector** instalada.
- Acceso a la API de Kunna y un token por cada colección que quieras usar.

---

## Puesta en marcha

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar la base de datos

Crea la extensión pgvector y la tabla `buildings`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE buildings (
    sigua                  TEXT PRIMARY KEY,        -- código SIGUA, ej: '0025'
    nombre                 TEXT NOT NULL,           -- nombre oficial del edificio
    description_embedding  TEXT,                    -- descripción que enriquece el embedding
    plantas                TEXT[],                  -- plantas disponibles, ej: {0,1,2}
    center_lat             DOUBLE PRECISION,        -- latitud del centro
    center_lon             DOUBLE PRECISION,        -- longitud del centro
    embedding              vector(768)              -- vector semántico (se genera al cargar)
);
```

> El modelo de embeddings produce vectores de **768 dimensiones**.

### 3. Variables de entorno

Crea un `.env` en la raíz:

```bash
# --- Servidor ---
PORT=3000
NODE_ENV=development            # 'development' desactiva la auth Bearer

# --- Base de datos ---
DATABASE_URL=postgres://usuario:password@localhost:5432/tu_base

# --- API Kunna ---
KUNNA_ENDPOINT_API=https://.../api
KUNNA_API_TOKEN_ENERGY=xxxxx
KUNNA_API_TOKEN_WATER=xxxxx
KUNNA_API_TOKEN_WEATHER=xxxxx
KUNNA_API_TOKEN_ROOMSENSORS=xxxxx
KUNNA_API_TOKEN_WIFI=xxxxx

# --- Seguridad ---
MCP_AUTH_TOKEN=tu_token_secreto # obligatorio si NODE_ENV != development
CORS_ALLOWED_ORIGINS=https://midominio.com,https://otro.com
```

Cada colección usa su propio token, leído como `KUNNA_API_TOKEN_<COLECCIÓN>`. Las colecciones activas ahora mismo son: `energy`, `water`, `weather`, `roomsensors` y `wifi`.

### 4. Cargar los edificios

```bash
# 1) Fusiona los GeoJSON de data/buildings en data/edificios.json
node src/scripts/mergeBuildings.js

# 2) Carga edificios.json en la BD y genera sus embeddings
node src/scripts/loadBuildings.js
#   --force          regenera TODOS los embeddings (no solo los que falten)
#   <ruta.json>      usa otro JSON en lugar de data/edificios.json

# 3) (Opcional) Comprueba que la búsqueda semántica responde bien
node src/scripts/test-embeddings-buildings.js
```

> La primera ejecución descarga el modelo de embeddings, así que tardará un poco más.

### 5. Arrancar el servidor

```bash
node index.js
```

Verás un log indicando el puerto y el entorno. El servidor escucha en `0.0.0.0:<PORT>`.

---

## Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| `GET` | `/health` | Estado del servidor + métricas de sesiones y streams |
| `POST` | `/mcp` | Inicialización y llamadas MCP (tools, prompts, etc.) |
| `GET` | `/mcp` | Canal SSE de notificaciones servidor → cliente |
| `DELETE` | `/mcp` | Cierre explícito de una sesión |

Salvo en `development`, todas las peticiones a `/mcp` requieren cabecera `Authorization: Bearer <MCP_AUTH_TOKEN>`.

---

## Capacidades MCP

### Tools

| Tool | Qué hace |
|---|---|
| `search-campus-buildings` | Resuelve un edificio por SIGUA o por descripción (embeddings). |
| `discover-collection` | Vista general de una colección: qué mide y qué magnitudes tiene. |
| `query-data` | Lecturas crudas y descubrimiento de dispositivos + metadatos (en una sola llamada con `include_metadata`). |
| `query-aggregation` | Datos agregados (media, máx, mín, suma…) por intervalos horarios o diarios. |
| `get-device-details` | Detalles completos de un dispositivo concreto ya conocido. |

### Prompts

| Prompt | Genera |
|---|---|
| `informe-electricidad-edificio-mensual` | Informe mensual de consumo eléctrico + anomalías. |
| `informe-agua-edificio-mensual` | Informe mensual de agua + detección de fugas. |
| `informe-confort-aula` | Análisis de CO₂, temperatura, humedad y VOC de un aula según normativa. |

---

## Flujo típico

1. El cliente pregunta algo en lenguaje natural (*"informe de luz de la poli en junio"*).
2. El prompt orquesta los pasos: `search-campus-buildings` resuelve el edificio → `query-data` descubre sus contadores → `query-aggregation` saca los consumos.
3. El servidor habla con la API de Kunna y con la base de datos de embeddings según haga falta.
4. El modelo redacta el informe con la estructura definida en el prompt.

---

## Notas
- **Certificados TLS.** En `index.js` se desactiva la verificación de certificados (`NODE_TLS_REJECT_UNAUTHORIZED = '0'`) como apaño temporal mientras se arregla el certificado de la API externa. Conviene quitarlo en cuanto se resuelva.

---

## TFG

Proyecto desarrollado como Trabajo de Fin de Grado en la Universidad de Alicante.

- **Servidor (este repo):** servidor MCP de datos IoT del campus.
- **Cliente:** [`enlace-al-repo-del-cliente`](#).
- **Autor/a:** _(tu nombre)_
- **Tutor/a:** _(nombre del tutor)_