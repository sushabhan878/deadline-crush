FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY --chown=node:node . .
RUN npm run build -w apps/web
USER node
ENV NODE_ENV=production SERVE_WEB=1
EXPOSE 3000
ENTRYPOINT ["tini", "-g", "--"]
CMD ["sh", "infra/start.sh"]
