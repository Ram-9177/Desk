# ONE Desk: one container, data (SQLite + uploads) kept in the /app/data volume.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4300
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
# a fresh named volume inherits this ownership, so the app can run as the unprivileged `node` user
RUN mkdir -p data/uploads && chown -R node:node data
USER node
EXPOSE 4300
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:4300/api/health || exit 1
CMD ["node", "--no-warnings", "server.js"]
