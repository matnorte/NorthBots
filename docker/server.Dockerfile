FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @northbot/server...
RUN pnpm --filter @northbot/server build
RUN pnpm --filter @northbot/server deploy --prod /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
