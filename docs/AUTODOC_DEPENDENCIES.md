# Gestión de Dependencias y Ecosistema Técnico

Este documento proporciona un inventario detallado de las librerías, frameworks y herramientas que componen el ecosistema técnico de la aplicación. Está diseñado para que los equipos de ingeniería y operaciones entiendan las dependencias, su propósito y la postura de mantenimiento del stack.

---

## 📦 Inventario de Dependencias de Producción (dependencies)

Estas dependencias son críticas para el funcionamiento en tiempo de ejecución del API Gateway. Su ausencia o fallo impedirá que el sistema se inicie o procese peticiones.

| Dependencia | Versión | Criticidad | Propósito y Justificación (Categoría) |
| :--- | :--- | :--- | :--- |
| **fastify** | ^5.8.5 | **Bloqueante** | Motor HTTP del Gateway. Gestiona las peticiones de entrada y el enrutamiento base (Core). |
| **undici** | ^6.26.0 | **Bloqueante** | Cliente HTTP de alto rendimiento para el proxy inverso y reenvío de peticiones (Red). |
| **ioredis** | ^5.10.1 | **Alta** | Cliente de Redis para almacenar cuotas de Rate Limiting distribuidas (Datos/Estado). |
| **jose** | ^6.2.3 | **Alta** | Firma y verificación de tokens JWT para rutas con autenticación obligatoria (Seguridad). |
| **zod** | ^4.4.3 | **Bloqueante** | Validación estricta en tiempo de ejecución de esquemas de configuración (Validación). |
| **pino** | ^10.3.1 | **Bloqueante** | Engine de registro (logging) ultrarrápido en formato JSON para producción (Logs). |
| **prom-client** | ^15.1.3 | **Media** | Exportador de métricas para ser scrapeadas por Prometheus (Observabilidad). |
| **js-yaml** | ^4.1.1 | **Bloqueante** | Parser del archivo de configuración `gateway.yaml` de formato YAML (Utilidad/Datos). |
| **uuid** | ^14.0.0 | **Alta** | Generación de identificadores de trazas únicos (Correlation IDs) por request (Utilidad). |

---

## 🛠️ Dependencias de Desarrollo y Calidad (devDependencies)

Herramientas utilizadas exclusivamente durante la fase de desarrollo, testing, control de calidad y empaquetado. No se instalan en el entorno de ejecución de producción.

| Herramienta | Versión | Categoría | Propósito |
| :--- | :--- | :--- | :--- |
| **typescript** | ^6.0.3 | Compilación | Transpilador oficial de TypeScript a JavaScript moderno (ESM). |
| **vitest** | ^4.1.7 | Testing | Framework de pruebas de alto rendimiento, nativo con ESM. |
| **@vitest/coverage-v8** | ^4.1.7 | Calidad | Módulo para la generación de reportes de cobertura de código. |
| **tsx** | ^4.22.3 | Desarrollo | Ejecutor de TypeScript bajo demanda (watch) en desarrollo local. |
| **eslint** | ^10.4.0 | Calidad | Análisis estático de código para evitar errores de estilo y bugs. |
| **prettier** | ^3.8.3 | Formato | Formateador estricto para asegurar un estilo de código consistente. |
| **ts-jest / jest** | ^29.4.10 | Testing | Módulos heredados para pruebas basadas en Jest (en migración). |
| **@types/node** | ^25.9.1 | Tipos | Definición de tipos estáticos para las APIs nativas de Node.js. |

---

## 📈 Ecosistema y Modernidad del Stack

El stack de este API Gateway destaca por su adopción de estándares modernos y herramientas de alta eficiencia en el ecosistema Node.js:

1. **Gestor de Paquetes Eficiente (pnpm)**: Se utiliza **pnpm v9** como gestor exclusivo. A través de su enlace por hardlinks, optimiza el espacio y previene la descarga duplicada de dependencias.
2. **Fastify v5**: Proporciona un rendimiento significativamente mayor que Express y maneja soporte nativo para TypeScript.
3. **Undici v6**: Cliente HTTP de última generación oficial de Node.js, optimizado para pools de sockets persistentes y multiplexación.
4. **Vitest v4**: Ofrece ejecución de pruebas ultra rápida y soporte nativo para módulos ESM sin sobrecargas de configuración.
