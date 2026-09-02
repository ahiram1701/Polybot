# syntax=docker/dockerfile:1
#
# Polybot en contenedor. Reproduce lo que ya hacia `scripts/install-systemd.sh`, que es el patron de
# despliegue probado del proyecto: `npm ci` -> `npm run build` -> `npm run ui:build` y arrancar
# `dist/src/ui/index.js --static`.
#
# Guia de uso y trampas: docs/docker.md

# ---------------------------------------------------------------------------
# build — compila TypeScript y el cliente de vite. Necesita devDependencies.
# ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Las dependencias van en su propia capa: cambiar un .ts no debe reinstalar node_modules.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts vitest.config.ts ./
COPY src ./src
# `tsconfig.json` incluye tests/, asi que tienen que estar para que `tsc` no falle por ficheros que
# dice compilar y no encuentra.
COPY tests ./tests

RUN npm run build && npm run ui:build \
    # Los tests compilados no pintan nada en produccion y arrastran imports de vitest.
    && rm -rf /app/dist/tests

# ---------------------------------------------------------------------------
# deps — solo dependencias de produccion, en un arbol limpio.
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
# Las recompensas se abonan ~00:45 UTC y el limite de gasto es POR DIA: si el contenedor corta el dia
# en otro huso, el contador y el exchange dejan de hablar del mismo dia. Se fija aqui y compose lo
# repite, para que valga igual si alguien lanza la imagen a mano.
ENV TZ=UTC
# Sin esto el servidor escucha en 127.0.0.1 DEL CONTENEDOR, que no es alcanzable desde fuera: el
# puerto publicado no lleva a ningun sitio y parece que la UI no arranco. Quien acota el acceso es la
# publicacion del puerto en compose (127.0.0.1:8787:8787), no esta variable.
ENV POLYBOT_UI_HOST=0.0.0.0
# Quien relanza el proceso si muere. Lo lee la UI para no ofrecer el interruptor del watchdog de
# Windows, que aqui no lo lee nadie. Ver src/ui/shared.ts (`SupervisorKind`).
ENV POLYBOT_SUPERVISOR=compose

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# `package.json` lleva `"type": "module"`. Sin el, Node lee los .js como CommonJS y el arranque muere
# con "Cannot use import statement outside a module".
COPY package.json ./

# El estado vive aqui y se monta desde el host. Se crea con el dueno correcto en la imagen para que,
# si alguien arranca SIN montar el volumen, el bot pueda escribir igual en vez de fallar al primer
# guardado.
RUN mkdir -p /app/data && chown -R node:node /app/data

# La imagen trae el usuario `node` con UID 1000, que es el habitual del primer usuario de WSL. Si el
# tuyo no es 1000, NO hay que reconstruir: compose acepta `user: "${UID}:${GID}"`. Ver docs/docker.md.
USER node

EXPOSE 8787

# Node 22 trae `fetch` global, asi que no hace falta curl en la imagen.
#
# Sondea /api/health, que devuelve 503 cuando el feed lleva demasiado sin ticks — o sea que distingue
# "el bot esta ciego" de "el servidor responde". OJO: Docker NO reinicia por si solo un contenedor
# unhealthy; esto da VISIBILIDAD, no la paridad completa con `scripts/watchdog.ps1`, que si relanzaba
# un bot vivo pero ciego. Esa brecha esta documentada en docs/docker.md.
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.POLYBOT_UI_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/ui/index.js", "--static"]
