# Spec: Plugin JWT con validación JWKS para SafeGateway

> **Estado**: Pendiente de implementación
> **Proyecto destino**: [SafeGateway](https://github.com/Srozasc/SafeGateway)
> **Origen**: Gap identificado durante la planificación de Flash Drop Backend

---

## User Story

> **Como** operador del API Gateway en una arquitectura de microservicios
> **quiero** que el plugin `jwt-auth` valide tokens JWT contra un endpoint JWKS remoto (en lugar de un secreto compartido)
> **para** que las claves privadas de firma queden aisladas en el Auth Service, eliminando el riesgo de compromiso del gateway y habilitando rotación de claves sin redeploy.

---

## Contexto

SafeGateway ya tiene un plugin `jwt-auth` (`src/middleware/jwt-auth/`) que usa `jose` y soporta HS256 (secreto compartido) y RS256 (clave pública local). Este spec **extiende** ese plugin para soportar validación contra un endpoint JWKS remoto, manteniendo compatibilidad con las configuraciones existentes.

### Por qué importa

Con validación HS256 (estado actual sin JWKS):
- El gateway necesita conocer el secreto compartido para verificar tokens.
- Si el gateway se compromete, el secreto queda expuesto.
- Rotación de claves requiere actualizar el secreto en todos los gateways (downtime coordinado).

Con validación JWKS (este spec):
- El gateway solo conoce las **claves públicas** del Auth Service.
- Rotación de claves: el Auth Service publica la nueva clave pública en JWKS, el gateway la cachea automáticamente.
- Múltiples issuers pueden coexistir (multi-tenant, multi-entorno).

---

## Asunciones Aceptadas

### Funcionales

- **J1**: Auth Service expone `GET /.well-known/jwks.json` (RFC 7517).
- **J2**: Tokens usan algoritmo RS256.
- **J3**: Tokens incluyen `kid` en el header.
- **J4**: Compatibilidad con HS256 mantenida.
- **J5**: Soporte para múltiples issuers.
- **J6**: Gateway NO firma tokens, solo valida.
- **J7**: `kid` desconocido → 401 Unauthorized.

### Técnicas

- **J8**: JWKS cache TTL: 1 hora por defecto.
- **J9**: Refresh on miss cuando un `kid` no está en cache.
- **J10**: Validación de claims: `iss`, `aud`, `exp`, `nbf`, `iat`.
- **J11**: `iss` debe coincidir con el issuer configurado.
- **J12**: `aud` opcional.
- **J13**: HTTPS estándar (sin mTLS).
- **J14**: Refresh de JWKS en background.
- **J15**: Error de red al obtener JWKS → 503.
- **J16**: Logging: debug para OK, warn para rechazo, error para fallo de JWKS.
- **J17**: Métricas Prometheus para validaciones y refreshes.

---

## Configuración

### Mockup ASCII — Modo JWKS (nuevo)

```yaml
# config/gateway.yaml

# ── Plugin JWT con validación JWKS ──────────────────────────
jwtAuth:
  enabled: true
  mode: jwks                        # "jwks" | "shared-secret" (default: "shared-secret")
  issuers:
    - name: auth-service-prod
      jwksUri: https://auth.flashdrop.cl/.well-known/jwks.json
      issuer: "https://auth.flashdrop.cl"   # claim "iss" esperado
      audience: "flashdrop-api"             # claim "aud" esperado (opcional)
      cacheTtlSeconds: 3600                 # default: 3600 (1h)
      refreshOnMiss: true                   # default: true
      timeoutMs: 3000                       # default: 3000

    - name: auth-service-staging
      jwksUri: https://auth-staging.flashdrop.cl/.well-known/jwks.json
      issuer: "https://auth-staging.flashdrop.cl"
      cacheTtlSeconds: 600                  # 10 min en staging (rotación más rápida)

routes:
  # ── Ruta protegida con issuer específico ─────────────────
  - prefix: /api/orders
    target: http://orders-service:8084
    stripPrefix: true
    jwtAuth:
      issuer: auth-service-prod            # Referencia al issuer configurado arriba

  # ── Ruta que acepta tokens de cualquier issuer ───────────
  - prefix: /api/public
    target: http://public-service:8086
    stripPrefix: true
    jwtAuth:
      issuer: any                          # Acepta tokens de cualquier issuer configurado

  # ── Ruta sin protección JWT ──────────────────────────────
  - prefix: /api/health
    target: http://health-service:8087
    stripPrefix: true
    # jwtAuth no presente → ruta pública
```

### Mockup ASCII — Modo shared-secret (compatibilidad existente)

```yaml
# Configuración actual (sigue funcionando sin cambios)
jwtAuth:
  enabled: true
  mode: shared-secret                 # default
  secret: ${JWT_SECRET}               # HS256 con secreto compartido
  algorithms:
    - HS256
  issuer: "flashdrop-api"             # claim "iss" esperado
  audience: "flashdrop-api"           # claim "aud" esperado (opcional)

routes:
  - prefix: /api/protected
    target: http://backend:3000
    stripPrefix: true
    jwtAuth:
      required: true                  # default: true si jwtAuth está habilitado globalmente
```

### Mockup ASCII — Ruta con JWT deshabilitado

```yaml
routes:
  - prefix: /api/auth/login
    target: http://auth-service:8082
    stripPrefix: true
    jwtAuth:
      required: false                 # Login es público (necesita recibir credenciales, no tokens)
```

---

## BDD Scenarios

### Escenario 1: Validación exitosa con kid conocido en cache

```gherkin
Given el gateway con JWKS cacheado para auth-service-prod (TTL válido)
When un cliente hace GET /api/orders con Authorization: Bearer <token>
  | Header del token: alg=RS256, kid="key-2026-01" |
  | Payload: iss="https://auth.flashdrop.cl", aud="flashdrop-api", exp=<futuro> |
Then el gateway extrae el "kid" del header
And busca la clave pública correspondiente en el JWKS cacheado
And valida la firma del token con RS256 usando esa clave
And valida los claims iss, aud, exp
And permite el paso al backend
And registra log debug: "jwt: token validated successfully for kid=key-2026-01"
And incrementa métrica: gateway_jwt_validations_total{result="ok"} += 1
```

### Escenario 2: Refresh on miss cuando kid no está en cache

```gherkin
Given el gateway con JWKS cacheado que NO contiene kid="key-2026-06"
When un cliente hace GET /api/orders con Authorization: Bearer <token>
  | Header: alg=RS256, kid="key-2026-06" |
Then el gateway NO rechaza inmediatamente
And fuerza un refresh del JWKS desde https://auth.flashdrop.cl/.well-known/jwks.json
And el nuevo JWKS contiene kid="key-2026-06"
And re-valida el token con la nueva clave
And permite el paso al backend
And registra log debug: "jwt: refresh-on-miss found new kid=key-2026-06"
And incrementa métrica: gateway_jwks_refresh_total{result="ok"} += 1
```

### Escenario 3: Refresh on miss no encuentra el kid

```gherkin
Given el gateway fuerza un refresh del JWKS
And el nuevo JWKS NO contiene kid="key-unknown"
When el cliente presenta un token con kid="key-unknown"
Then el gateway responde HTTP 401 con JSON:
  """
  {
    "error": "unauthorized",
    "message": "unknown signing key"
  }
  """
And registra log warn: "jwt: unknown kid=key-unknown after refresh"
And incrementa métrica: gateway_jwt_validations_total{result="unknown_kid"} += 1
```

### Escenario 4: Token expirado

```gherkin
Given un token con exp=<pasado>
When el cliente hace request con ese token
Then el gateway responde HTTP 401 con JSON:
  """
  {
    "error": "unauthorized",
    "message": "token expired"
  }
  """
And registra log debug: "jwt: token expired"
And incrementa métrica: gateway_jwt_validations_total{result="expired"} += 1
```

### Escenario 5: Issuer incorrecto

```gherkin
Given el gateway configurado con issuer="https://auth.flashdrop.cl"
When un cliente presenta un token con iss="https://other-service.com"
Then el gateway responde HTTP 401 con JSON:
  """
  {
    "error": "unauthorized",
    "message": "invalid issuer"
  }
  """
And incrementa métrica: gateway_jwt_validations_total{result="invalid"} += 1
```

### Escenario 6: Audience incorrecto

```gherkin
Given el gateway configurado con audience="flashdrop-api"
When un cliente presenta un token con aud="other-api"
Then el gateway responde HTTP 401 con mensaje "invalid audience"
```

### Escenario 7: Auth Service no disponible durante validación

```gherkin
Given el gateway con cache expirado y refresh-on-miss activado
And el Auth Service NO responde (timeout o connection refused)
When un cliente presenta un token
Then el gateway intenta refresh → falla con error de red
And el gateway responde HTTP 503 con JSON:
  """
  {
    "error": "service_unavailable",
    "message": "unable to verify token: auth service unreachable"
  }
  """
And registra log error: "jwt: JWKS refresh failed - ECONNREFUSED"
And incrementa métrica: gateway_jwks_refresh_total{result="error"} += 1
```

### Escenario 8: Múltiples issuers configurados

```gherkin
Given el gateway con dos issuers:
  | auth-service-prod     | https://auth.flashdrop.cl/.well-known/jwks.json     |
  | auth-service-staging  | https://auth-staging.flashdrop.cl/.well-known/jwks.json |
When un cliente presenta un token firmado por auth-service-prod
Then el gateway valida contra el JWKS del issuer correspondiente
And el token es aceptado

When un cliente presenta un token firmado por auth-service-staging
Then el gateway valida contra el JWKS del issuer correspondiente
And el token es aceptado
```

### Escenario 9: Ruta con jwtAuth.required=false (login público)

```gherkin
Given la ruta /api/auth/login con jwtAuth.required=false
When un cliente hace POST /api/auth/login SIN Authorization header
Then el gateway NO valida JWT
And pasa el request al backend normalmente
```

### Escenario 10: Compatibilidad con HS256 (modo shared-secret)

```gherkin
Given el gateway configurado en modo shared-secret con secret="my-secret"
When un cliente presenta un token HS256 firmado con "my-secret"
Then el gateway valida el token correctamente
And permite el paso al backend
And NO consulta ningún endpoint JWKS (modo HS256 no usa JWKS)
```

### Escenario 11: Validación al startup — jwksUri inválido

```gherkin
Given el archivo gateway.yaml con:
  """
  jwtAuth:
    mode: jwks
    issuers:
      - name: bad-issuer
        jwksUri: "not-a-valid-url"
  """
When el gateway arranca
Then la validación Zod falla con error:
  """
  jwtAuth.issuers[0].jwksUri: must be a valid URL
  """
And el proceso aborta con exit code 1
```

### Escenario 12: Validación al startup — issuer duplicado

```gherkin
Given el archivo gateway.yaml con dos issuers con name="auth-service"
When el gateway arranca
Then la validación Zod falla con error:
  """
  jwtAuth.issuers: duplicate issuer name "auth-service"
  """
```

### Escenario 13: Cache TTL funcionando correctamente

```gherkin
Given el gateway con cacheTtlSeconds=3600 y JWKS cacheado al tiempo T
When un cliente presenta un token en T+1800 (30 min después)
Then el gateway valida contra el JWKS cacheado (no refresh)
And el cache aún es válido (TTL no expirado)

When un cliente presenta un token en T+3700 (después del TTL)
And el token tiene un kid que SÍ está en cache
Then el gateway detecta cache expirado y hace refresh en background
And valida el token contra el JWKS actualizado
```

### Escenario 14: Hot-reload de configuración jwtAuth

```gherkin
Given el gateway corriendo con un issuer configurado
When el operador envía SIGHUP con un nuevo issuer añadido a la lista
Then el ConfigReloader valida la nueva config con Zod
And si pasa: el snapshot se actualiza
And los nuevos issuers están disponibles inmediatamente
And los issuers existentes mantienen su cache
```

### Escenario 15: Token sin header kid (legacy)

```gherkin
Given el gateway en modo JWKS
When un cliente presenta un token RS256 SIN header kid
Then el gateway responde HTTP 401 con mensaje "missing kid header"
And incrementa métrica: gateway_jwt_validations_total{result="invalid"} += 1
```

---

## Criterios de Aceptación

### Funcionales

- [ ] Validación JWT contra JWKS remoto funciona con RS256.
- [ ] Soporte para múltiples issuers simultáneos.
- [ ] Refresh on miss cuando un kid no está en cache.
- [ ] Validación de claims iss, aud, exp, nbf, iat.
- [ ] Compatibilidad con modo HS256 (shared-secret) sin breaking changes.
- [ ] Rutas con `jwtAuth.required=false` permiten acceso sin token.
- [ ] Rutas sin configuración `jwtAuth` siguen siendo públicas (default).

### Técnicos

- [ ] Extensión del plugin existente en `src/middleware/jwt-auth/` (no crear plugin nuevo).
- [ ] Nuevo módulo `src/middleware/jwt-auth/jwks-client.ts` para fetching y caching.
- [ ] Schema Zod extendido en `src/config/schema.ts` para soportar modo `jwks`.
- [ ] Refresh de JWKS en background (no bloquea validación).
- [ ] Hot-reload de configuración `jwtAuth.*` soportado.
- [ ] Tests unitarios cubren los 15 BDD scenarios.
- [ ] Tests de integración con mock JWKS server.
- [ ] Cobertura ≥85% en `src/middleware/jwt-auth/`.
- [ ] Documentación actualizada en CLAUDE.md y README.md.

### Operacionales

- [ ] Métricas Prometheus: `gateway_jwt_validations_total`, `gateway_jwks_refresh_total`.
- [ ] Logs estructurados con nivel apropiado por resultado.
- [ ] Latencia de validación con cache hit <5ms p99.
- [ ] Sin nuevas dependencias externas (reutilizar `jose` ya incluido).

---

## Dependencias

### Internas (SafeGateway)

- `src/middleware/jwt-auth/` — plugin existente a extender
- `src/middleware/pipeline.ts` — interfaz `GatewayPlugin`
- `src/config/schema.ts` — extender schema Zod
- `src/config/reloader.ts` — hot-reload
- `src/middleware/metrics/` — añadir collectors

### Externas

- `jose` (ya incluida) — librería JWT.
- `undici` (ya incluida) o `fetch` nativo de Node 20+ — para obtener JWKS.
- Ninguna dependencia nueva.

---

## Fuera de Alcance (Out of Scope)

- Firma de tokens (solo validación).
- mTLS entre gateway y Auth Service.
- Refresh tokens (solo access tokens).
- Revocación activa de tokens (el gateway no mantiene blocklist; solo valida firma y exp).
- Soporte para algoritmos distintos a RS256 y HS256 (excluir ES256, PS256, etc. en esta versión).
- Persistencia del cache JWKS entre reinicios del gateway.
- Soporte para JWE (JSON Web Encryption) — solo JWS.

---

## Mockup ASCII — Arquitectura del flujo de validación

```
    Cliente ────GET /api/orders────► Gateway
                  Authorization: Bearer <JWT>
                                         │
                                         ▼
                  ┌──────────────────────────────────┐
                  │ 1. Extraer header del JWT        │
                  │    alg=RS256, kid="key-2026-06"  │
                  └────────────────┬─────────────────┘
                                   │
                                   ▼
                  ┌──────────────────────────────────┐
                  │ 2. Buscar kid en JWKS Cache      │
                  │    ┌─────────────────────────┐   │
                  │    │ key-2026-01             │   │
                  │    │ key-2026-03             │   │
                  │    │ key-2026-04             │   │
                  │    └─────────────────────────┘   │
                  │    ¿kid="key-2026-06" presente? │
                  └────────────────┬─────────────────┘
                                   │
                          ┌────────┴────────┐
                          │                 │
                       [Sí]              [No]
                          │                 │
                          ▼                 ▼
            ┌─────────────────────┐  ┌──────────────────┐
            │ 3a. Validar firma   │  │ 3b. Refresh JWKS │
            │     con clave       │  │     en background│
            │     pública         │  │     desde        │
            │                     │  │     JWKS URI     │
            └──────────┬──────────┘  └────────┬─────────┘
                       │                      │
                       │                      ▼
                       │           ┌─────────────────────┐
                       │           │ ¿kid ahora existe? │
                       │           └──────────┬──────────┘
                       │                      │
                       │             ┌────────┴────────┐
                       │             │                 │
                       │          [Sí]              [No]
                       │             │                 │
                       │             ▼                 ▼
                       │     ┌──────────────┐  ┌──────────────┐
                       │     │ 3c. Validar  │  │ HTTP 401     │
                       │     │ con nueva    │  │ unknown kid  │
                       │     │ clave        │  └──────────────┘
                       │     └──────┬───────┘
                       │            │
                       └────────────┤
                                    ▼
                       ┌─────────────────────────┐
                       │ 4. Validar claims       │
                       │    iss, aud, exp, nbf   │
                       └────────────┬────────────┘
                                    │
                          ┌─────────┴─────────┐
                          │                   │
                       [Válido]          [Inválido]
                          │                   │
                          ▼                   ▼
                  ┌──────────────┐    ┌──────────────┐
                  │ 5. Pasar al  │    │ HTTP 401     │
                  │    backend   │    │ + métrica    │
                  └──────────────┘    └──────────────┘
```

---

## Mockup ASCII — Estructura de archivos sugerida

```
src/middleware/jwt-auth/
├── plugin.ts                  # Extender para soportar ambos modos
├── verifier.ts                # Lógica común de validación
├── jwks-client.ts             # NUEVO: fetch + cache JWKS
├── shared-secret.ts           # NUEVO: lógica HS256 (extraída del plugin actual)
├── metrics.ts                 # NUEVO: collectors Prometheus
├── types.ts                   # Extender con tipos JWKS
└── index.ts                   # Exports

tests/unit/middleware/jwt-auth/
├── verifier.test.ts
├── jwks-client.test.ts        # NUEVO
├── jwks-validation.test.ts    # NUEVO: 15 BDD scenarios
└── shared-secret.test.ts      # NUEVO: tests de compatibilidad
```

---

## Notas de Implementación

### 1. Reutilizar `jose` para JWKS

`jose` provee `createRemoteJWKSet()` que maneja cache y refresh automáticamente. Considerar usarlo en lugar de implementar caching manual:

```typescript
import { createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(new URL(jwksUri), {
  cacheMaxAge: cacheTtlSeconds * 1000,
  cooldownDuration: 30_000,  // No refrescar más de 1 vez cada 30s
  timeoutDuration: timeoutMs,
});

const { payload } = await jwtVerify(token, JWKS, {
  issuer,
  audience,
});
```

**Consideración**: `createRemoteJWKSet` no implementa "refresh on miss" exactamente como se describe en J9. Si se quiere control fino, implementar el cache manualmente.

### 2. Mapeo de errores a HTTP status

```typescript
const errorToStatus = {
  'JWT_EXPIRED': { status: 401, message: 'token expired' },
  'JWT_CLAIM_VALIDATION_FAILED': { status: 401, message: 'invalid claim' },
  'JOSE_ERROR': { status: 401, message: 'invalid token' },
  'JWKS_FETCH_ERROR': { status: 503, message: 'auth service unreachable' },
  'UNKNOWN_KID': { status: 401, message: 'unknown signing key' },
};
```

### 3. Métricas Prometheus

```typescript
// En src/middleware/jwt-auth/metrics.ts
export const jwtValidations = new Counter({
  name: 'gateway_jwt_validations_total',
  help: 'Total JWT validation attempts',
  labelNames: ['result'],  // ok, invalid, expired, unknown_kid
});

export const jwksRefreshes = new Counter({
  name: 'gateway_jwks_refresh_total',
  help: 'Total JWKS refresh attempts',
  labelNames: ['result'],  // ok, error
});
```

### 4. Compatibilidad hacia atrás

El cambio NO debe romper configuraciones existentes:

```typescript
// Modo default: shared-secret (sin cambios)
jwtAuth:
  secret: ${JWT_SECRET}

// Modo nuevo: jwks (opt-in)
jwtAuth:
  mode: jwks
  issuers: [...]
```

Si `mode` no se especifica, el plugin asume `shared-secret` (comportamiento actual).

### 5. Multi-issuer routing

Cuando hay múltiples issuers configurados y una ruta no especifica cuál usar:

```typescript
// Buscar en TODOS los issuers hasta encontrar uno que valide el token
for (const issuer of issuers) {
  try {
    await verify(token, issuer);
    return;  // Token válido para este issuer
  } catch {
    continue;  // Probar siguiente
  }
}
throw new UnauthorizedError('no issuer validated token');
```

---

## Referencias

- [RFC 7517: JSON Web Key (JWK)](https://www.rfc-editor.org/rfc/rfc7517)
- [RFC 7519: JSON Web Token (JWT)](https://www.rfc-editor.org/rfc/rfc7519)
- [Auth0: Validating JWTs with JWKS](https://auth0.com/docs/secure/tokens/json-web-tokens/validate-json-web-tokens)
- [`jose` library: createRemoteJWKSet](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)
- SafeGateway existentes: `src/middleware/jwt-auth/` (plugin actual a extender)