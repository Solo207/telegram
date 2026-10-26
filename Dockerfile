FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js generate-session.js ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1
USER node
CMD ["node", "server.js"]
