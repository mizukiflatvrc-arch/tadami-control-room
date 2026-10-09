# Version pinned; review registry digest and security updates before deployment.
FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts vite.server.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY public ./public
COPY tools/production/check-build.ts ./tools/production/check-build.ts
RUN npm run build:production

FROM node:22.23.2-bookworm-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.23.2-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-deps /app/package.json ./package.json
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
USER 1000:1000
EXPOSE 8787
CMD ["node", "dist-server/api.js"]

FROM node:22.23.2-bookworm-slim AS web
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-deps /app/package.json ./package.json
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-web ./dist-web
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist-server/web.js"]
