FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server ./server
COPY --chown=node:node scripts ./scripts
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data/attachments && chown -R node:node /app/data
USER node
ENV PORT=3001 ATTACHMENTS_PATH=/app/data/attachments
EXPOSE 3001
CMD ["npm", "start"]
