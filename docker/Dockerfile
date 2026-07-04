# ==========================================
# Stage 1: Compilación de la aplicación
# ==========================================
FROM node:20-alpine AS builder

RUN apk add --no-cache ca-certificates

# Instalar y activar pnpm v9 vía corepack (compatible con Node.js 20)
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Copiar manifiestos y archivos de configuración mínimos para dependencias
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./

# Instalar todas las dependencias incluyendo las de desarrollo para compilar
RUN pnpm install --frozen-lockfile

# Copiar el código fuente
COPY src/ ./src

# Compilar TypeScript a JavaScript vanilla en /dist
RUN pnpm build

# ==========================================
# Stage 2: Runtime de producción ligero
# ==========================================
FROM node:20-alpine AS runtime

RUN apk add --no-cache ca-certificates

# Habilitar corepack en la imagen final con la misma versión fijada
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Copiar manifiestos
COPY package.json pnpm-lock.yaml ./

# Instalar EXCLUSIVAMENTE dependencias de producción
RUN pnpm install --prod --frozen-lockfile

# Copiar el código transpilado del stage anterior
COPY --from=builder /app/dist ./dist

# Configuración de variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV CONFIG_PATH=/app/config/gateway.yaml

# Exponer el puerto del Gateway
EXPOSE 3000

# Healthcheck de red utilizando netcat (nc) disponible en Alpine
# Comprueba atómicamente si el puerto TCP de Fastify responde
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD nc -z localhost ${PORT} || exit 1

# Comando de arranque del servidor
CMD ["node", "dist/index.js"]
