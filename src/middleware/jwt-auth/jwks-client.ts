import { Logger } from 'pino';
import type { JwtIssuerConfig, JwkResolution, JwksCacheState } from './types.js';
import { recordJwksRefresh } from './metrics.js';

/**
 * Cliente JWKS por issuer. Mantiene un cache local con tres estados lógicos:
 *  - `fresh`: dentro del TTL — sirve directo sin refresh
 *  - `stale`: pasó el TTL pero dentro de `staleGracePeriodSeconds` — sirve + dispara background refresh
 *  - `expired`: pasó ambos — requiere refresh on miss (gated por cooldown)
 *
 * Concurrencia: implementa single-flight en `fetchNow()` para evitar requests
 * paralelos al mismo endpoint JWKS.
 */
export class JwksClient {
  private readonly cfg: JwtIssuerConfig;
  private readonly childLogger: Logger;

  private keys: { keys: Array<Record<string, unknown>> } | null = null;
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private lastErrorAt = 0;

  private refreshTimer: NodeJS.Timeout | null = null;
  private inflight: Promise<{ keys: Array<Record<string, unknown>> } | null> | null = null;
  private stopped = true;

  constructor(cfg: JwtIssuerConfig, logger: Logger) {
    this.cfg = cfg;
    this.childLogger = logger.child({ module: 'jwks', issuer: cfg.name });
  }

  /**
   * Arranca el ciclo de background refresh. Idempotente.
   * La primera invocación agenda un fetch para `cacheTtlSeconds` ms en el futuro.
   */
  public ensureStarted(): void {
    if (!this.stopped) {return;}
    this.stopped = false;
    this.scheduleBackgroundRefresh(this.cfg.cacheTtlSeconds * 1000);
  }

  /**
   * Resuelve una clave por `kid`. Si no está en cache y `refreshOnMiss=true`,
   * dispara un refresh síncrono (gated por cooldown). Si está `stale`, dispara
   * un background refresh pero sirve la versión stale inmediatamente.
   */
  public async resolveKey(kid: string): Promise<JwkResolution> {
    const state = this.computeState();

    if (state === 'fresh' || state === 'stale') {
      const found = this.findKid(kid);
      if (found !== null) {
        if (state === 'stale') {
          // Trigger background refresh sin bloquear (fire & forget)
          this.scheduleBackgroundRefresh(this.cfg.cacheTtlSeconds * 1000);
        }
        return { jwkSet: this.keys, state, foundKid: found };
      }
    }

    // Kid no encontrado o estado vacío/expired: intentar refresh on miss
    if (this.cfg.refreshOnMiss) {
      const fresh = await this.fetchNow();
      if (fresh) {
        const found = this.findKidInSet(fresh, kid);
        if (found !== null) {
          return { jwkSet: fresh, state: 'fresh', foundKid: found };
        }
      } else if (this.canServeStale()) {
        // Refresh falló pero estamos dentro de stale grace: servir stale
        const found = this.findKid(kid);
        if (found !== null) {
          this.childLogger.warn(
            { kid, staleSinceSeconds: Math.round((Date.now() - this.fetchedAt) / 1000) },
            'jwt: sirviendo claves stale tras fallo de refresh',
          );
          return { jwkSet: this.keys, state: 'stale', foundKid: found };
        }
      }
    }

    return { jwkSet: this.keys, state, foundKid: null };
  }

  /**
   * Fetch síncrono del JWKS. Gated por `refreshCooldownSeconds`:
   * si la última tentativa fue hace menos del cooldown, retorna la cache
   * actual (o null si está vacía).
   *
   * Implementa single-flight: requests concurrentes esperan el mismo Promise.
   */
  public async fetchNow(): Promise<{ keys: Array<Record<string, unknown>> } | null> {
    const now = Date.now();
    const cooldownMs = this.cfg.refreshCooldownSeconds * 1000;
    if (now - this.lastAttemptAt < cooldownMs) {
      recordJwksRefresh('cooldown');
      return this.keys;
    }

    // Single-flight: si ya hay un fetch en curso, esperar el mismo.
    if (this.inflight) {
      return this.inflight;
    }

    this.lastAttemptAt = now;
    this.inflight = this.performFetch().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }

  /**
   * Detiene el background refresh y espera el fetch en curso (si lo hay).
   * Diseñado para llamarse desde gracefulShutdown o reload de config.
   */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        // Ignorar: el error ya se logueó en performFetch()
      }
    }
  }

  /** Estado actual del cache (computed on-demand a partir de timestamps). */
  public getState(): JwksCacheState {
    return this.computeState();
  }

  /** Snapshot de estadísticas internas (útil para debugging y tests). */
  public getStats(): {
    state: JwksCacheState;
    keyCount: number;
    fetchedAt: number;
    lastAttemptAt: number;
    lastErrorAt: number;
  } {
    return {
      state: this.computeState(),
      keyCount: this.keys?.keys.length ?? 0,
      fetchedAt: this.fetchedAt,
      lastAttemptAt: this.lastAttemptAt,
      lastErrorAt: this.lastErrorAt,
    };
  }

  // --- Internals ---

  private async performFetch(): Promise<{ keys: Array<Record<string, unknown>> } | null> {
    this.childLogger.debug({ uri: this.cfg.jwksUri }, 'jwt: fetching JWKS');

    try {
      const response = await fetch(this.cfg.jwksUri, {
        method: 'GET',
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        recordJwksRefresh('error');
        this.lastErrorAt = Date.now();
        this.childLogger.error(
          { status: response.status, uri: this.cfg.jwksUri },
          'jwt: JWKS endpoint returned non-OK status',
        );
        return null;
      }

      const payload = (await response.json()) as unknown;
      if (!this.isJwksPayload(payload)) {
        recordJwksRefresh('error');
        this.lastErrorAt = Date.now();
        this.childLogger.error(
          { uri: this.cfg.jwksUri },
          'jwt: JWKS payload missing "keys" array',
        );
        return null;
      }

      this.keys = { keys: payload.keys };
      this.fetchedAt = Date.now();
      recordJwksRefresh('ok');
      this.transitionTo('fresh');
      this.childLogger.debug(
        { keyCount: payload.keys.length },
        'jwt: JWKS cache refreshed successfully',
      );
      return this.keys;
    } catch (error) {
      recordJwksRefresh('error');
      this.lastErrorAt = Date.now();
      this.childLogger.error(
        { err: this.normalizeFetchError(error), uri: this.cfg.jwksUri },
        'jwt: JWKS refresh failed',
      );
      return null;
    }
  }

  private scheduleBackgroundRefresh(delayMs: number): void {
    if (this.stopped) {return;}
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.performFetch().finally(() => {
        if (!this.stopped) {
          this.scheduleBackgroundRefresh(this.cfg.cacheTtlSeconds * 1000);
        }
      });
    }, delayMs);
  }

  private computeState(): JwksCacheState {
    if (!this.keys || this.fetchedAt === 0) {return 'empty';}
    const ageMs = Date.now() - this.fetchedAt;
    const ttlMs = this.cfg.cacheTtlSeconds * 1000;
    const graceMs = ttlMs + this.cfg.staleGracePeriodSeconds * 1000;
    if (ageMs < ttlMs) {return 'fresh';}
    if (ageMs < graceMs) {return 'stale';}
    return 'expired';
  }

  private canServeStale(): boolean {
    return this.computeState() === 'stale';
  }

  private findKid(kid: string): string | null {
    return this.findKidInSet(this.keys, kid);
  }

  private findKidInSet(
    set: { keys: Array<Record<string, unknown>> } | null,
    kid: string,
  ): string | null {
    if (!set) {return null;}
    for (const key of set.keys) {
      if (key.kid === kid) {return kid;}
    }
    return null;
  }

  private transitionTo(newState: JwksCacheState): void {
    this.childLogger.debug({ newState }, 'jwt: cache state transition');
  }

  private isJwksPayload(value: unknown): value is { keys: Array<Record<string, unknown>> } {
    if (typeof value !== 'object' || value === null) {return false;}
    const keys = (value as { keys?: unknown }).keys;
    return Array.isArray(keys);
  }

  private normalizeFetchError(error: unknown): string {
    if (error instanceof Error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      if (cause?.code) {return `${error.name} (${cause.code})`;}
      return error.name;
    }
    return String(error);
  }
}