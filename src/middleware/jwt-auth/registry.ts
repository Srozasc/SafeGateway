import { Logger } from 'pino';
import type { JwtGlobalConfig, JwtIssuerConfig } from '../../config/types.js';
import { JwksClient } from './jwks-client.js';

/**
 * Registry de clientes JWKS por issuer. Construido desde `JwtGlobalConfig.issuers[]`.
 * Permite resolver clientes por:
 *  - nombre declarado (`issuer: <name>`)
 *  - claim `iss` decodificado sin verificar (`issuer: any` + iss lookup)
 *
 * El registry NO persiste entre reinicios. Al recargar la configuración (SIGHUP),
 * el `ConfigReloader` construye un registry nuevo y reemplaza el snapshot.
 */
export class JwtAuthRegistry {
  private readonly clientsByName = new Map<string, JwksClient>();
  private readonly clientsByIssuerClaim = new Map<string, JwksClient>();
  private readonly issuerConfigs = new Map<string, JwtIssuerConfig>();
  private readonly logger: Logger;
  private readonly globalConfig: JwtGlobalConfig | undefined;

  constructor(globalConfig: JwtGlobalConfig | undefined, logger: Logger) {
    this.logger = logger;
    this.globalConfig = globalConfig;

    if (!globalConfig) {
      return;
    }

    for (const issuerCfg of globalConfig.issuers) {
      const client = new JwksClient(issuerCfg, logger);
      this.clientsByName.set(issuerCfg.name, client);
      this.clientsByIssuerClaim.set(issuerCfg.issuer, client);
      this.issuerConfigs.set(issuerCfg.name, issuerCfg);
    }
  }

  /**
   * Resuelve un cliente por nombre declarado en `jwt.issuers[]`.
   * Retorna undefined si el nombre no existe (la validación cross-ref del loader
   * debería haber detectado esto al arranque; este método es defensivo).
   */
  public getClient(issuerName: string): JwksClient | undefined {
    return this.clientsByName.get(issuerName);
  }

  /**
   * Resuelve un cliente por el claim `iss` extraído del JWT (decode-unsafe).
   * Usado cuando una ruta declara `issuer: "any"` para mapear dinámicamente
   * al issuer correspondiente.
   *
   * IMPORTANTE: el valor de `iss` aquí NO es confiable — solo se usa para
   * mapear al proveedor JWKS adecuado. La verificación de firma posterior
   * asegura que el token realmente fue emitido por esa entidad.
   */
  public resolveByIssClaim(issClaim: string): JwksClient | null {
    return this.clientsByIssuerClaim.get(issClaim) ?? null;
  }

  /**
   * Retorna la lista de nombres de issuers registrados.
   */
  public listIssuerNames(): string[] {
    return [...this.clientsByName.keys()];
  }

  /**
   * Retorna la configuración de un issuer por nombre.
   */
  public getIssuerConfig(issuerName: string): JwtIssuerConfig | undefined {
    return this.issuerConfigs.get(issuerName);
  }

  /**
   * Retorna la configuración global (o undefined si no hay sección `jwt`).
   */
  public getGlobalConfig(): JwtGlobalConfig | undefined {
    return this.globalConfig;
  }

  /**
   * Arranca el background refresh de TODOS los clientes. Idempotente.
   * Llamado desde el bootstrap tras construir el registry inicial.
   */
  public startAll(): void {
    for (const client of this.clientsByName.values()) {
      client.ensureStarted();
    }
    this.logger.debug(
      { issuerCount: this.clientsByName.size },
      'jwt: registry started — background refresh habilitado',
    );
  }

  /**
   * Detiene el background refresh de TODOS los clientes.
   * Llamado desde gracefulShutdown y desde ConfigReloader antes de reemplazar el snapshot.
   */
  public async stopAll(): Promise<void> {
    const all = [...this.clientsByName.values()];
    await Promise.all(all.map((c) => c.stop()));
    this.logger.debug('jwt: registry stopped — background refresh deshabilitado');
  }
}