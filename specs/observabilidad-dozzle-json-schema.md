# Especificación: Observabilidad Ultra-Ligera — Dozzle + JSON Schema

## Resumen

**Historia de usuario:**
> Como operador del API Gateway, quiero poder visualizar los logs de mis contenedores Docker en tiempo real desde una interfaz web (Dozzle) y tener autocompletado inteligente + validación al editar el `gateway.yaml` en VS Code (JSON Schema), para mejorar la observabilidad y reducir errores de configuración sin añadir código al componente del Gateway.

**Tipo de cambio:** Infraestructura y tooling de desarrollo (zero-code en `src/`).

**Principio rector:** No se modifica ningún archivo de código fuente del Gateway. Esta feature es puramente aditiva sobre Docker Compose y configuración de VS Code.

---

## Componentes Afectados

| Componente | Tipo de Cambio | Archivo |
|---|---|---|
| Docker Compose | MODIFICAR | `docker/docker-compose.example.yml` |
| JSON Schema | NUEVO | `config/gateway-schema.json` |
| VS Code Settings | MODIFICAR | `.vscode/settings.json` |
| Documentación | MODIFICAR | `README.md` |

---

## Parte 1 — Dozzle: Visualizador de Logs en Tiempo Real

### Descripción

Dozzle es una aplicación web escrita en Go que consume menos de 10 MB de RAM. Se conecta al socket de Docker y muestra los logs de los contenedores en tiempo real con interfaz moderna, búsqueda de texto y filtros.

### Requisitos Detallados

**Servicio Docker Compose:**

```yaml
dozzle:
  image: amir20/dozzle:latest
  container_name: gateway-logs
  ports:
    - "9999:8080"
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
  environment:
    - DOZZLE_NO_ANALYTICS=true
  networks:
    - gateway-network
```

**Reglas de configuración:**

- **Puerto:** `9999` en el host → `8080` interno de Dozzle.
- **Socket Docker:** Montado en modo solo lectura (`:ro`) por seguridad.
- **Analytics:** Deshabilitados (`DOZZLE_NO_ANALYTICS=true`) para respetar la privacidad del desarrollador.
- **Red:** Conectado a `gateway-network` para que pueda ver todos los contenedores del stack.
- **Sin `depends_on`:** Dozzle puede arrancar en cualquier orden; si un contenedor aún no existe, aparecerá cuando se levante.
- **Sin autenticación:** Este es un entorno de desarrollo local. Para producción, Dozzle soporta auth básica vía variables de entorno (fuera del alcance del MVP).

**Acceso:**

- URL local: `http://localhost:9999`
- Funcionalidades visibles: logs en tiempo real de `gateway-service`, `gateway-redis` y `mock-service` (si está activo).

### Escenarios BDD — Dozzle

```gherkin
Feature: Visualización de logs en tiempo real con Dozzle

  Background:
    Given el stack Docker Compose está levantado con "docker compose -f docker/docker-compose.example.yml up -d"
    And el servicio "gateway-logs" (Dozzle) está en estado "running"

  Scenario: Acceder a la interfaz web de Dozzle
    When el operador abre el navegador en "http://localhost:9999"
    Then se muestra la interfaz de Dozzle con la lista de contenedores activos
    And el contenedor "gateway-service" aparece en la lista
    And el contenedor "gateway-redis" aparece en la lista

  Scenario: Ver logs del Gateway en tiempo real
    Given el operador tiene abierta la interfaz de Dozzle en "http://localhost:9999"
    When el operador selecciona el contenedor "gateway-service"
    Then se muestran los logs existentes del contenedor en formato JSON
    And los logs incluyen el mensaje de arranque "API Gateway levantado y escuchando en http://0.0.0.0:3000"

  Scenario: Logs de nuevas peticiones aparecen en tiempo real
    Given el operador está viendo los logs del contenedor "gateway-service" en Dozzle
    When se realiza una petición HTTP "GET http://localhost:3000/api/pokemon/ditto" desde Postman
    Then aparece una nueva línea de log en Dozzle con el campo "msg" conteniendo "fetching from remote server"
    And la línea aparece sin necesidad de refrescar la página

  Scenario: Buscar en los logs
    Given el operador está viendo los logs del contenedor "gateway-service" en Dozzle
    And existen al menos 5 líneas de log
    When el operador escribe "Rate limit" en el campo de búsqueda de Dozzle
    Then solo se muestran las líneas que contienen "Rate limit" en su contenido

  Scenario: Dozzle no afecta el arranque del Gateway
    Given el servicio "dozzle" está detenido o no existe
    When se ejecuta "docker compose -f docker/docker-compose.example.yml up -d gateway"
    Then el servicio "gateway-service" arranca correctamente
    And el Gateway responde peticiones HTTP en el puerto 3000

  Scenario: Dozzle solo tiene acceso de lectura al socket Docker
    Given el servicio "dozzle" está en estado "running"
    When se inspecciona la configuración de montaje del contenedor "gateway-logs"
    Then el volumen "/var/run/docker.sock" está montado con permisos "ro" (solo lectura)
```

---

## Parte 2 — JSON Schema para `gateway.yaml`

### Descripción

Un archivo JSON Schema que describe la estructura válida del archivo `gateway.yaml`. Al asociarlo en VS Code mediante la extensión YAML de Red Hat, el editor proporciona:

- **Autocompletado inteligente** de propiedades y valores.
- **Validación en tiempo real** (errores subrayados en rojo).
- **Documentación emergente** (tooltips en español al hacer hover).

### Requisitos Detallados

**Ubicación del archivo:** `config/gateway-schema.json`

**Fuente de verdad:** El schema se genera a partir del esquema Zod existente en `src/config/schema.ts`. Las propiedades, tipos, valores por defecto y restricciones deben ser idénticos.

**Estructura esperada del JSON Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "gateway-config",
  "title": "Configuración del API Gateway",
  "description": "Esquema de validación para el archivo gateway.yaml del API Gateway HTTP Modular.",
  "type": "object",
  "required": ["redis", "routes"],
  "properties": {
    "server": { ... },
    "redis": { ... },
    "logging": { ... },
    "routes": { ... },
    "overrides": { ... }
  }
}
```

**Mapeo Zod → JSON Schema detallado:**

| Zod Schema | JSON Schema | Descripción (tooltip en VS Code) |
|---|---|---|
| `ServerConfigSchema.port` | `integer`, min: 1, max: 65535, default: 3000 | "Puerto en el que escucha el servidor HTTP del Gateway." |
| `ServerConfigSchema.host` | `string`, minLength: 1, default: "0.0.0.0" | "Dirección IP de escucha. Usar '0.0.0.0' para aceptar conexiones de cualquier interfaz." |
| `RedisConfigSchema.url` | `string`, pattern: `^rediss?://` | "URL de conexión a Redis. Debe comenzar con 'redis://' o 'rediss://' (TLS)." |
| `RedisConfigSchema.onFailure` | `string`, enum: ["open", "closed"], default: "open" | "Comportamiento cuando Redis no está disponible. 'open' = permitir tráfico (fail-open). 'closed' = bloquear con 503." |
| `LoggingConfigSchema.level` | `string`, enum: ["debug", "info", "warn", "error"], default: "info" | "Nivel mínimo de logging. Los logs por debajo de este nivel se descartan." |
| `RouteConfigSchema.prefix` | `string`, pattern: `^/` | "Prefijo de la ruta que el Gateway interceptará. Debe comenzar con '/' y no terminar con '/' (excepto la raíz)." |
| `RouteConfigSchema.target` | `string`, format: "uri" | "URL del backend destino al que se reenviarán las peticiones. Debe usar protocolo http:// o https://." |
| `RouteConfigSchema.stripPrefix` | `boolean`, default: false | "Si es true, el prefijo se elimina antes de reenviar al backend. Ej: /api/users → /users." |
| `RouteConfigSchema.rateLimit` | objeto opcional | "Configuración de Rate Limiting para esta ruta." |
| `RateLimitConfigSchema.maxRequests` | `integer`, minimum: 1 | "Número máximo de peticiones permitidas por IP en la ventana temporal." |
| `RateLimitConfigSchema.windowSeconds` | `integer`, minimum: 1 | "Duración de la ventana temporal en segundos para el conteo de peticiones." |
| `RouteTimeoutConfigSchema.connect` | `integer`, minimum: 1, opcional | "Timeout en milisegundos para establecer la conexión con el backend." |
| `RouteTimeoutConfigSchema.response` | `integer`, minimum: 1, opcional | "Timeout en milisegundos para recibir la primera respuesta del backend." |
| `OverrideConfigSchema.path` | `string`, pattern: `^/` | "Path exacto para aplicar un rate limit diferente al de la ruta padre." |
| `OverrideConfigSchema.rateLimit` | objeto requerido | "Rate limit específico para este path. Sobreescribe el de la ruta padre." |
| `routes` (array) | `array`, minItems: 1 | "Lista de rutas que el Gateway intercepta y reenvía a backends." |
| `overrides` (array) | `array`, opcional | "Lista de overrides de rate limit para paths específicos." |

**Configuración de VS Code (`.vscode/settings.json`):**

```json
{
  "yaml.schemas": {
    "./config/gateway-schema.json": [
      "config/gateway.yaml",
      "config/gateway.example.yaml",
      "docker/gateway.yaml"
    ]
  }
}
```

Esto asocia el schema a todos los archivos YAML de configuración del Gateway, incluyendo el que se usa dentro de Docker.

### Escenarios BDD — JSON Schema

```gherkin
Feature: Autocompletado y validación del gateway.yaml con JSON Schema en VS Code

  Background:
    Given el archivo "config/gateway-schema.json" existe en el proyecto
    And el archivo ".vscode/settings.json" tiene la asociación de schema YAML configurada
    And la extensión "redhat.vscode-yaml" está instalada en VS Code

  Scenario: Autocompletado de propiedades de primer nivel
    Given el operador abre el archivo "docker/gateway.yaml" en VS Code
    When posiciona el cursor en una línea vacía a nivel raíz
    And presiona Ctrl+Espacio para activar el autocompletado
    Then aparecen sugerencias que incluyen "server", "redis", "logging", "routes", "overrides"

  Scenario: Autocompletado de propiedades anidadas dentro de una ruta
    Given el operador está editando una entrada dentro de "routes:" en "docker/gateway.yaml"
    When posiciona el cursor dentro de un elemento de la lista de rutas
    And presiona Ctrl+Espacio
    Then aparecen sugerencias que incluyen "prefix", "target", "stripPrefix", "rateLimit", "timeout"

  Scenario: Validación de tipo incorrecto en el puerto del servidor
    Given el operador abre el archivo "docker/gateway.yaml" en VS Code
    When modifica el campo "server.port" al valor "abc" (string en vez de integer)
    Then VS Code muestra un error de validación indicando que se esperaba un tipo "integer"
    And la línea con el error aparece subrayada en rojo

  Scenario: Validación de URL de Redis con formato inválido
    Given el operador abre el archivo "docker/gateway.yaml" en VS Code
    When modifica el campo "redis.url" al valor "http://localhost:6379"
    Then VS Code muestra un error de validación indicando que el patrón no coincide
    And el tooltip del error indica que la URL debe comenzar con "redis://" o "rediss://"

  Scenario: Validación de que routes no esté vacío
    Given el operador abre el archivo "docker/gateway.yaml" en VS Code
    When elimina todos los elementos del array "routes" dejándolo como "routes: []"
    Then VS Code muestra un error indicando que el array debe tener al menos 1 elemento

  Scenario: Tooltip descriptivo al hacer hover sobre una propiedad
    Given el operador abre el archivo "docker/gateway.yaml" en VS Code
    When posiciona el cursor sobre la propiedad "stripPrefix"
    Then aparece un tooltip con la descripción en español:
      "Si es true, el prefijo se elimina antes de reenviar al backend. Ej: /api/users → /users."

  Scenario: Validación de valor de enum inválido en logging.level
    Given el operador abre el archivo "docker/gateway.yaml" en VS Code
    When modifica el campo "logging.level" al valor "verbose"
    Then VS Code muestra un error indicando que el valor debe ser uno de: "debug", "info", "warn", "error"

  Scenario: El schema no interfiere con comentarios YAML
    Given el operador abre el archivo "docker/gateway.yaml" en VS Code
    When añade un comentario "# Nota: esta ruta apunta a PokéAPI" encima de una ruta
    Then VS Code no muestra errores de validación
    And el autocompletado sigue funcionando correctamente
```

---

## Parte 3 — Documentación

### Requisitos

Se actualizará el `README.md` con una nueva sección que cubra:

1. **Acceso a Dozzle**: URL, captura de referencia y casos de uso.
2. **Autocompletado YAML**: Requisito de la extensión de Red Hat, comportamiento esperado.
3. **Regeneración del JSON Schema**: Instrucciones para actualizar el schema si se modifica el Zod.

---

## Criterios de Aceptación Globales

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | El contenedor `gateway-logs` (Dozzle) se levanta correctamente con el stack completo | `docker compose up -d` y verificar `docker ps` |
| CA-2 | La interfaz de Dozzle es accesible en `http://localhost:9999` | Abrir navegador y verificar que la UI carga |
| CA-3 | Los logs del `gateway-service` se muestran en tiempo real en Dozzle | Hacer peticiones HTTP y verificar que aparecen sin refrescar |
| CA-4 | El archivo `config/gateway-schema.json` es un JSON Schema válido | Validar con un linter de JSON Schema |
| CA-5 | VS Code muestra autocompletado al editar `docker/gateway.yaml` | Presionar Ctrl+Espacio y verificar sugerencias |
| CA-6 | VS Code subraya errores de validación en el YAML | Introducir un valor inválido y verificar la marca roja |
| CA-7 | Los tooltips de las propiedades aparecen en español | Hacer hover sobre cualquier propiedad y verificar la descripción |
| CA-8 | No se ha modificado ningún archivo en `src/` | Verificar con `git diff --name-only src/` (debe estar vacío) |
| CA-9 | El Gateway arranca correctamente aún sin Dozzle | Levantar solo `gateway` y `redis-cache` y verificar que funciona |
| CA-10 | El `README.md` documenta Dozzle y el autocompletado YAML | Revisar sección nueva en el README |

---

## Archivos a Crear/Modificar — Resumen

| Archivo | Acción | Descripción |
|---|---|---|
| `docker/docker-compose.example.yml` | MODIFICAR | Añadir servicio `dozzle` |
| `config/gateway-schema.json` | NUEVO | JSON Schema generado desde Zod |
| `.vscode/settings.json` | MODIFICAR | Añadir asociación `yaml.schemas` |
| `README.md` | MODIFICAR | Documentar Dozzle y autocompletado YAML |

---

## Flujos Alternativos

### FA-1: Docker Desktop no expone el socket en la ruta estándar
- **Síntoma**: Dozzle arranca pero no muestra contenedores.
- **Causa**: En algunos sistemas Windows, el socket se monta en una ruta diferente.
- **Solución**: Cambiar el volumen a `//var/run/docker.sock:/var/run/docker.sock:ro` (doble barra) o usar el named pipe de Windows `//./pipe/docker_engine`.

### FA-2: La extensión YAML de Red Hat no está instalada
- **Síntoma**: No hay autocompletado ni validación en los archivos YAML.
- **Solución**: VS Code mostrará una recomendación en el archivo `.vscode/extensions.json` (si se configura). El usuario debe instalar `redhat.vscode-yaml`.

### FA-3: El esquema Zod se actualiza pero el JSON Schema no
- **Síntoma**: El autocompletado de VS Code no refleja las nuevas propiedades.
- **Solución**: Regenerar manualmente el JSON Schema y verificar que los campos coincidan. Documentar este paso en el README.
