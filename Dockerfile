# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
# ==============================================================================
# Pinned to the *build* platform: this stage only runs tsc + tsc-alias, whose
# output is plain architecture-independent JavaScript, so emulating it for a
# foreign target buys nothing. Bun 1.4.0 also aborts under qemu, which makes a
# cross-arch build of this stage fail outright rather than merely run slowly.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# The BuildKit cache mount persists Bun's global package cache across builds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts.
# ==============================================================================
FROM oven/bun:1.4.2-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance and to ensure only
# production dependencies are installed.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION
LABEL org.opencontainers.image.title="openaq-mcp-server"
LABEL org.opencontainers.image.description="Measured air quality via the OpenAQ v3 API — physical-sensor observations from government monitors worldwide, with location/readings/measurements tools and DataCanvas SQL over historical series."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/cyanheads/openaq-mcp-server"

# Copy dependency manifests and preserve the install supply-chain guards.
COPY package.json bun.lock bunfig.toml ./

# Seed the configured dev-only scanner before the production-filtered install.
COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner

# Install only production dependencies, ignoring any lifecycle scripts (like 'prepare')
# that are not needed in the final production image.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# Installed by default; omit with --build-arg OTEL_ENABLED=false.
# Resolve each package inside the installed framework's tested peer range.
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      specs=$(bun -e ' \
        const { peerDependencies: peers } = await Bun.file("node_modules/@cyanheads/mcp-ts-core/package.json").json(); \
        const names = process.argv.slice(1); \
        const missing = names.filter((name) => !peers?.[name]); \
        if (missing.length > 0) throw new Error(`no peerDependencies range for ${missing.join(", ")}`); \
        console.log(names.map((name) => `${name}@${peers[name]}`).join(" ")); \
      ' \
        @hono/otel \
        @opentelemetry/api-logs \
        @opentelemetry/exporter-logs-otlp-http \
        @opentelemetry/exporter-metrics-otlp-http \
        @opentelemetry/exporter-trace-otlp-http \
        @opentelemetry/instrumentation-http \
        @opentelemetry/instrumentation-pino \
        @opentelemetry/resources \
        @opentelemetry/sdk-logs \
        @opentelemetry/sdk-metrics \
        @opentelemetry/sdk-node \
        @opentelemetry/sdk-trace-node \
        @opentelemetry/semantic-conventions) \
      && bun add --omit=dev --omit=peer --ignore-scripts $specs; \
    fi

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/openaq-mcp-server && chown -R bun:bun /var/log/openaq-mcp-server

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/openaq-mcp-server"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
