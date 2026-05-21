import { Logger } from 'pino';
import { loadConfig } from './loader.js';
import { RouteRegistry } from '../routing/registry.js';
import { GatewayConfig, ConfigSnapshot, ReloadResult } from './types.js';

export class ConfigReloader {
  private isReloading = false;

  constructor(
    private readonly configPath: string,
    private readonly snapshotRef: { current: ConfigSnapshot },
    private readonly logger: Logger,
  ) {}

  /**
   * Ejecuta el proceso completo de recarga de configuración en caliente.
   * Thread-safe mediante mutex lógico interno.
   */
  public async reload(): Promise<ReloadResult> {
    if (this.isReloading) {
      this.logger.warn('Recarga de configuración ya en curso. Señal SIGHUP ignorada.');
      return {
        success: false,
        applied: [],
        ignored: [],
        error: 'Recarga en curso',
      };
    }

    this.isReloading = true;

    // Ceder el control al event loop (microtask yield) para permitir que el mutex
    // bloquee llamadas concurrentes que se inicien en la misma ráfaga de microtareas.
    await Promise.resolve();

    this.logger.info('Señal SIGHUP recibida. Iniciando recarga de configuración...');

    try {
      // 1. Cargar, interpolar y validar el archivo YAML
      // loadConfig maneja la lectura, interpolación y validación con Zod
      const newConfig = loadConfig(this.configPath);
      const oldConfig = this.snapshotRef.current.config;

      // 2. Comparar diferencias entre la configuración vieja y la nueva
      const { applied, ignored } = this.detectChanges(oldConfig, newConfig);

      // 3. Si no hay cambios aplicables, terminar pacíficamente
      if (applied.length === 0) {
        this.logger.info(
          { ignoredChanges: ignored },
          'No se detectaron cambios aplicables en la configuración.',
        );
        this.isReloading = false;
        return { success: true, applied: [], ignored };
      }

      // 4. Construir un nuevo ConfigSnapshot atómicamente
      const newRegistry = new RouteRegistry(newConfig);
      const newSnapshot: ConfigSnapshot = {
        config: newConfig,
        registry: newRegistry,
        createdAt: new Date().toISOString(),
      };

      // 5. Swap atómico de la referencia
      this.snapshotRef.current = newSnapshot;

      // 6. Aplicar cambios dinámicos adicionales (logging level)
      if (oldConfig.logging.level !== newConfig.logging.level) {
        this.logger.level = newConfig.logging.level;
      }

      this.logger.info(
        { appliedChanges: applied, ignoredChanges: ignored },
        'Configuración recargada exitosamente en caliente.',
      );

      this.isReloading = false;
      return { success: true, applied, ignored };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { err: error instanceof Error ? { message: error.message, stack: error.stack } : error },
        `Recarga de configuración fallida. Manteniendo configuración anterior. Error: ${errorMessage}`,
      );
      this.isReloading = false;
      return {
        success: false,
        applied: [],
        ignored: [],
        error: errorMessage,
      };
    }
  }

  /**
   * Compara dos configuraciones para clasificar los cambios en aplicables vs ignorados.
   */
  private detectChanges(
    oldConfig: GatewayConfig,
    newConfig: GatewayConfig,
  ): { applied: string[]; ignored: string[] } {
    const applied: string[] = [];
    const ignored: string[] = [];

    // --- Sección server ---
    if (oldConfig.server.port !== newConfig.server.port) {
      ignored.push('server.port');
    }
    if (oldConfig.server.host !== newConfig.server.host) {
      ignored.push('server.host');
    }

    // --- Sección redis ---
    if (oldConfig.redis.url !== newConfig.redis.url) {
      ignored.push('redis.url');
    }
    if (oldConfig.redis.onFailure !== newConfig.redis.onFailure) {
      ignored.push('redis.onFailure');
    }

    // --- Sección logging ---
    if (oldConfig.logging.level !== newConfig.logging.level) {
      applied.push(`logging.level: "${oldConfig.logging.level}" → "${newConfig.logging.level}"`);
    }

    // --- Sección routes (estructura de la lista) ---
    if (oldConfig.routes.length !== newConfig.routes.length) {
      ignored.push(
        `routes: la cantidad de rutas cambió de ${oldConfig.routes.length} a ${newConfig.routes.length}`,
      );
    }

    // --- Sección routes (comparación una a una) ---
    const minLength = Math.min(oldConfig.routes.length, newConfig.routes.length);
    for (let i = 0; i < minLength; i++) {
      const oldRoute = oldConfig.routes[i]!;
      const newRoute = newConfig.routes[i]!;

      if (oldRoute.prefix !== newRoute.prefix) {
        ignored.push(`routes[${i}].prefix`);
      }
      if (oldRoute.target !== newRoute.target) {
        ignored.push(`routes[${i}].target`);
      }
      if (oldRoute.stripPrefix !== newRoute.stripPrefix) {
        ignored.push(`routes[${i}].stripPrefix`);
      }

      // El rate limit SÍ se puede recargar dinámicamente en memoria
      if (JSON.stringify(oldRoute.rateLimit) !== JSON.stringify(newRoute.rateLimit)) {
        applied.push(`routes[${i}].rateLimit`);
      }

      // Los timeouts NO se pueden recargar porque van en el binding undici
      if (JSON.stringify(oldRoute.timeout) !== JSON.stringify(newRoute.timeout)) {
        ignored.push(`routes[${i}].timeout`);
      }
    }

    // --- Sección overrides ---
    if (JSON.stringify(oldConfig.overrides) !== JSON.stringify(newConfig.overrides)) {
      applied.push('overrides');
    }

    return { applied, ignored };
  }
}
