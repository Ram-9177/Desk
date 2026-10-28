# ONE Desk: one container, data (SQLite + uploads) kept in the /app/data volume.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4300
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4300
VOLUME ["/app/data"]
CMD ["node", "--no-warnings", "server.js"]
