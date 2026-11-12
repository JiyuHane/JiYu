FROM node:24.22.1-bookworm-slim AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.25.0
COPY . .
RUN pnpm install --frozen-lockfile \
    && SNOWLUMA_TARGET=linux-x64 pnpm run build:all \
    && pnpm run check:release-layout

FROM node:24.22.1-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/dist/ ./
COPY --from=build /workspace/LICENSE /usr/share/doc/snowluma/LICENSE
CMD ["node", "index.mjs"]
