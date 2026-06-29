# Spec: Plugin JWT con validación JWKS para SafeGateway

> **Estado**: Pendiente de implementación
> **Proyecto destino**: [SafeGateway](https://github.com/Srozasc/SafeGateway)
> **Origen**: Gap identificado durante la planificación de Flash Drop Backend

---

## User Story

> **Como** operador del API Gateway en una arquitectura de microservicios
> **quiero** que el plugin `jwt` valide tokens JWT contra un endpoint JWKS remoto (en lugar de un secreto compartido)
> **para** que las claves privadas de firma queden aisladas en el Auth Service, eliminando el riesgo de compromiso del gateway y habilitando rotación de claves sin redeploy.

---

## Contexto

SafeGateway ya tiene un plugin `jwt` (`src/middleware/jwt-auth/`) que usa `jose` y soporta algoritmos simétricos HMAC (HS256, HS384, HS512) usando un secreto compartido. Esta spec **extiende** ese plugin para soportar validación contra un endpoint JWKS remoto, manteniendo compatibilidad con las configuraciones existentes.

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

- **J8**: JWKS cache TTL: 1 hora por defecto (`cacheTtlSeconds: 3600`).
- **J9**: Refresh on miss síncrono cuando un `kid` no está en caché (con un cooldown por defecto de 30 segundos, configurable vía `refreshCooldownSeconds: 30`, para mitigar DoS).
- **J10**: Validación de claims: `iss`, `aud`, `exp`, `nbf`, `iat` (tolerancia de reloj de 60s, iat no puede ser futuro en más de 60s).
- **J11**: `iss` debe coincidir con el issuer configurado.
- **J12**: `aud` opcional.
- **J13**: HTTPS estándar (sin mTLS).
- **J14**: Refresh de JWKS en background ante expiración de TTL.
- **J15**: Error de red al obtener JWKS → 503 Service Unavailable (con ventana de gracia "stale" configurable para disponibilidad).
- **J16**: Logging: debug para OK, warn para rechazo, error para fallo de JWKS.
- **J17**: Métricas Prometheus idempotentes para validaciones y refreshes.

---

## Configuración

### Mockup ASCII — Modo JWKS (nuevo)

```yaml
# config/gateway.yaml

# ── Sección global de JWT ───────────────────────────────────
jwt:
  enabled: true
  mode: jwks                        # "jwks" | "shared-secret" (default: "shared-secret")
  issuers:
    - name: auth-service-prod
      jwksUri: https://auth.flashdrop.cl/.well-known/jwks.json
      issuer: "https://auth.flashdrop.cl"   # claim "iss" esperado
      audience: "flashdrop-api"             # claim "aud" esperado (opcional)
      cacheTtlSeconds: 3600                 # default: 3600 (1h)
      staleGracePeriodSeconds: 1800         # Ventana de gracia para usar keys "stale" si falla el refresh (default: 1800)
      refreshCooldownSeconds: 30            # Tiempo mínimo de espera entre refrescos síncronos (default: 30)
      refreshOnMiss: true                   # default: true
      timeoutMs: 3000                       # default: 3000

    - name: auth-service-staging
      jwksUri: https://auth-staging.flashdrop.cl/.well-known/jwks.json
      issuer: "https://auth-staging.flashdrop.cl"
      cacheTtlSeconds: 600                  # 10 min en staging (rotación más rápida)

routes:
  # ── Ruta protegida con issuer específico (Opt-in) ─────────
  - prefix: /api/orders
    target: http://orders-service:8084
    stripPrefix: true
    jwt:
      issuer: auth-service-prod            # Referencia al issuer configurado arriba

  # ── Ruta que acepta tokens de cualquier issuer (Opt-in) ───
  - prefix: /api/public
    target: http://public-service:8086
    stripPrefix: true
    jwt:
      issuer: any                          # Acepta tokens de cualquier issuer configurado

  # ── Ruta sin protección JWT (Pública por defecto) ────────
  - prefix: /api/health
    target: http://health-service:8087
    stripPrefix: true
    # jwt no presente → ruta pública
```

### Mockup ASCII — Modo shared-secret (compatibilidad existente por ruta)

Para garantizar la compatibilidad hacia atrás, si una ruta especifica su propio secreto y algoritmo de firma localmente (sin requerir la sección global `jwt`), el plugin debe seguir procesándolo normalmente utilizando el modo `shared-secret` de forma local:

```yaml
# config/gateway.yaml
# (No hay sección global 'jwt' o ésta define otra configuración)

routes:
  - prefix: /api/protected
    target: http://backend:3000
    stripPrefix: true
    jwt:
      enabled: true                   # Requerido explícitamente (modelo opt-in)
      secret: ${JWT_SECRET}           # Secreto definido a nivel de ruta (legacy/compatible)
      algorithm: HS256                # default
      issuer: "flashdrop-api"         # claim "iss" esperado
      audience: "flashdrop-api"       # claim "aud" esperado (opcional)
```

### Mockup ASCII — Ruta con JWT deshabilitado explícitamente

```yaml
routes:
  - prefix: /api/auth/login
    target: http://auth-service:8082
    stripPrefix: true
    jwt:
      enabled: false                 # Login es público explícitamente
```

---

## BDD Scenarios

### Escenario 1: Validación exitosa con kid conocido en caché

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

### Escenario 2: Refresh on miss síncrono cuando kid no está en caché

```gherkin
Given el gateway con JWKS cacheado que NO contiene kid="key-2026-06"
When un cliente hace GET /api/orders con Authorization: Bearer <token>
  | Header: alg=RS256, kid="key-2026-06" |
Then el gateway NO rechaza inmediatamente
And realiza una consulta HTTP síncrona para refrescar el JWKS desde la URI configurada
And el nuevo JWKS contiene kid="key-2026-06"
And valida el token con la nueva clave obtenida
And permite el paso al backend
And registra log debug: "jwt: refresh-on-miss found new kid=key-2026-06"
And incrementa métrica: gateway_jwks_refresh_total{result="ok"} += 1
```

### Escenario 3: Refresh on miss síncrono no encuentra el kid

```gherkin
Given el gateway fuerza un refresh síncrono del JWKS
And el nuevo JWKS obtenido NO contiene kid="key-unknown"
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

### Escenario 7: Auth Service no disponible durante refresh síncrono

```gherkin
Given el gateway con cache vacío o sin la clave solicitada
And el Auth Service NO responde (timeout o connection refused)
When un cliente presenta un token con kid desconocido
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

### Escenario 8: Múltiples issuers configurados (con route.jwt.issuer = any)

```gherkin
Given el gateway con dos issuers en su sección global:
  | auth-service-prod     | https://auth.flashdrop.cl/.well-known/jwks.json     |
  | auth-service-staging  | https://auth-staging.flashdrop.cl/.well-known/jwks.json |
When un cliente presenta un token con iss="https://auth.flashdrop.cl" en una ruta configurada con issuer "any"
Then el gateway decodifica el token de manera no fiable para leer el "iss"
And mapea que corresponde al emisor global "auth-service-prod"
And valida la firma del token contra las claves públicas asociadas a "auth-service-prod"
And permite el paso si la firma y claims son válidos
```

### Escenario 9: Ruta con jwt deshabilitado (enabled: false) o sin propiedad jwt

```gherkin
Given la ruta /api/auth/login con jwt.enabled=false
When un cliente hace POST /api/auth/login SIN Authorization header
Then el gateway NO valida JWT (ruta pública)
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
  jwt:
    mode: jwks
    issuers:
      - name: bad-issuer
        jwksUri: "not-a-valid-url"
  """
When el gateway arranca
Then la validación Zod falla con error:
  """
  jwt.issuers[0].jwksUri: must be a valid URL
  """
And el proceso aborta con exit code 1
```

### Escenario 12: Validación al startup — issuer duplicado

```gherkin
Given el archivo gateway.yaml con dos issuers con name="auth-service"
When el gateway arranca
Then la validación Zod falla con error:
  """
  jwt.issuers: duplicate issuer name "auth-service"
  """
```

### Escenario 13: TTL de caché y refresco asíncrono en background con ventana de gracia "stale"

```gherkin
Given el gateway con cacheTtlSeconds=3600 y staleGracePeriodSeconds=1800
When un cliente presenta un token en T+3700 (la caché local ha expirado por TTL)
And el kid del token está presente en la caché local
Then el gateway valida el token de forma inmediata con las claves locales existentes (latencia ultra baja)
And dispara un refresh del JWKS en segundo plano de manera asíncrona
```

### Escenario 13b: Fallo de red en refresco asíncrono bajo ventana de gracia

```gherkin
Given que el refresco asíncrono en background falla por error de red
And el tiempo transcurrido desde la expiración es menor a staleGracePeriodSeconds (1800s)
When un cliente presenta un token con kid presente en la caché "stale"
Then el gateway aprueba la firma basándose en la caché stale
And registra un log de warning indicando el fallo de refresco y el uso de claves stale
```

### Escenario 13c: Excedido el periodo de gracia stale tras fallo de red (Indisponibilidad)

```gherkin
Given que el refresco en background ha fallado repetidamente
And el tiempo transcurrido desde la expiración supera staleGracePeriodSeconds
When un cliente presenta un token con kid en la caché stale
Then el gateway rechaza el token y responde con HTTP 503 Service Unavailable
  """
  {
    "error": "service_unavailable",
    "message": "unable to verify token: auth service unreachable"
  }
  """
```

### Escenario 14: Hot-reload de configuración jwt

```gherkin
Given el gateway corriendo con un issuer configurado
When el operador envía SIGHUP con un nuevo issuer añadido a la lista
Then el ConfigReloader valida la nueva config con Zod
And si pasa: el snapshot se actualiza
And los nuevos issuers están disponibles inmediatamente
And los issuers existentes mantienen su cache
```

### Escenario 15: Token sin header kid (modo JWKS)

```gherkin
Given el gateway en modo JWKS
When un cliente presenta un token RS256 SIN header kid
Then el gateway responde HTTP 401 con mensaje "missing kid header"
And incrementa métrica: gateway_jwt_validations_total{result="invalid"} += 1
```

### Escenario 16: Token con iat en el futuro (derivación de reloj excesiva)

```gherkin
Given un cliente presenta un token con "iat" mayor a (tiempo_actual + 60 segundos)
When el gateway procesa la validación del token
Then el gateway responde HTTP 401 con JSON:
  """
  {
    "error": "unauthorized",
    "message": "token issued in the future"
  }
  """
And incrementa métrica: gateway_jwt_validations_total{result="invalid_claims"} += 1
```

---

## Criterios de Aceptación

### Funcionales

- [ ] Validación JWT contra JWKS remoto funciona con RS256.
- [ ] Soporte para múltiples issuers simultáneos.
- [ ] Refresh on miss síncrono limitado por cooldown cuando un kid no está en caché (cooldown por defecto de 30 segundos, configurable con `refreshCooldownSeconds`).
- [ ] Validación de claims iss, aud, exp, nbf, iat (con tolerancia de reloj de 60s; rechazar si iat está más de 60s en el futuro).
- [ ] Compatibilidad con modo HS256 (shared-secret) sin breaking changes. El plugin debe permitir que las rutas sigan declarando `secret` y `algorithm` de forma local e independiente sin requerir la sección global `jwt`.
- [ ] Rutas sin propiedad `jwt` o con `jwt.enabled=false` son tratadas como públicas (Opt-in estricto).

### Técnicos

- [ ] Extensión del plugin existente en `src/middleware/jwt-auth/` (no crear plugin nuevo).
- [ ] Nuevo módulo `src/middleware/jwt-auth/jwks-client.ts` para fetching, caching y lógica de refresco síncrona/background.
- [ ] Schema Zod extendido en `src/config/schema.ts` para soportar modo `jwks`.
- [ ] Soporte de periodo de gracia configurable (`staleGracePeriodSeconds`, default: 1800s) para usar llaves expiradas en caché si el Auth Service no está disponible.
- [ ] Si se excede el periodo de gracia y no se puede verificar contra un JWKS vigente por error de red, el gateway debe responder `503 Service Unavailable` por indisponibilidad de la infraestructura, reservando el `401` exclusivamente para tokens con fallos criptográficos (firma, exp, claims).
- [ ] Optimización de ruteo multi-issuer: decodificar primero sin verificar (`decodeJwt`) para extraer `iss`, validar que esté registrado en la configuración, y luego realizar la validación de firma con el JWKS respectivo.
- [ ] **Advertencia de seguridad obligatoria**: El claim `iss` extraído de la decodificación rápida no verificada se considerará **no confiable** y se utilizará únicamente a efectos de mapear al proveedor JWKS adecuado.
- [ ] Hot-reload de configuración `jwt.*` soportado.
- [ ] Tests unitarios cubren los escenarios BDD detallados.
- [ ] Tests de integración con mock JWKS server.
- [ ] Cobertura ≥85% en `src/middleware/jwt-auth/`.
- [ ] Documentación actualizada en CLAUDE.md and README.md.

### Operacionales

- [ ] Métricas Prometheus: `gateway_jwt_validations_total`, `gateway_jwks_refresh_total` utilizando un mecanismo de registro idempotente comprobando previamente la existencia de la métrica en el registro global de `prom-client` para evitar colisiones.
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
- `undici` o `fetch` nativo de Node 20+ — para obtener JWKS.

---

## Fuera de Alcance (Out of Scope)

- Firma de tokens (solo validación).
- mTLS entre gateway y Auth Service.
- Refresh tokens (solo access tokens).
- Revocación activa de tokens (el gateway no mantiene blocklist; solo valida firma y exp).
- Soporte para algoritmos distintos a RS256 y HS256.
- Persistencia del cache JWKS entre reinicios del gateway.
- Soporte para JWE (JSON Web Encryption) — solo JWS.