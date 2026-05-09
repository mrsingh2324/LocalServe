FROM node:20-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json

RUN npm ci

FROM deps AS build

COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
COPY packages/shared-types packages/shared-types

RUN npm run build --workspace @localserve/api
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20-slim AS runtime

ENV NODE_ENV=production
ENV USE_MONGO=true

WORKDIR /app/apps/api

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/packages /app/packages

EXPOSE 4000

CMD ["node", "dist/server.js"]
