export class GatewayError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    // Captura el stack trace correcto en Node
    Error.captureStackTrace(this.target || this, this.constructor);
  }

  // Getter de conveniencia para compatibilidad
  private get target(): Error {
    return this;
  }
}

export class ConfigError extends GatewayError {
  constructor(message: string) {
    super(message, 500);
  }
}

export class ConfigFileNotFoundError extends ConfigError {
  constructor(path: string) {
    super(`El archivo de configuración no existe en la ruta: ${path}`);
  }
}

export class ConfigParseError extends ConfigError {
  constructor(details: string) {
    super(`Sintaxis YAML de configuración inválida: ${details}`);
  }
}

export class ConfigValidationError extends ConfigError {
  constructor(errors: string[]) {
    super(`La validación de la configuración falló:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

export class MissingEnvVarError extends ConfigError {
  constructor(variableName: string) {
    super(`La variable de entorno requerida no está definida en el sistema: \${${variableName}}`);
  }
}

export class RouteNotFoundError extends GatewayError {
  constructor(path: string) {
    super(`No se encontró ninguna ruta registrada que coincida con el path: ${path}`, 404);
  }
}

export class RateLimitError extends GatewayError {
  constructor(message = 'Límite de peticiones excedido. Inténtalo de nuevo más tarde.') {
    super(message, 429);
  }
}

export class BackendError extends GatewayError {
  constructor(message: string, details?: string) {
    super(
      `Error al comunicarse con el servicio de destino (backend): ${message}${details ? ` (${details})` : ''}`,
      502,
    );
  }
}
