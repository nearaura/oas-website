ARG NODE_IMAGE=docker.m.daocloud.io/library/node:26.13.1-bookworm-slim

FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN npm install -g pnpm@11.15.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages ./packages

RUN pnpm install --frozen-lockfile

COPY . .

ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ENV NODE_ENV=production
ENV TINA_PUBLIC_IS_LOCAL=false
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}

RUN pnpm build

FROM ${NODE_IMAGE} AS runtime

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV NODE_ENV=production
ENV PORT=4322
ENV ASTRO_NODE_AUTOSTART=disabled

# Node 26 no longer bundles Corepack, so install pnpm explicitly.
RUN npm install -g pnpm@11.15.0

WORKDIR /app

# server.ts is intentionally run through tsx and imports Tina's TypeScript
# modules, so the runtime keeps the installed workspace dependencies.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages ./packages
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/tina ./tina
COPY --chown=node:node --from=build /app/src/content/docs ./src/content/docs
COPY --chown=node:node --from=build /app/server.ts /app/tsconfig.json /app/package.json ./

ENV pnpm_config_verify_deps_before_run=false
RUN chown node:node /app

USER node

EXPOSE 4322

CMD ["pnpm", "start"]
