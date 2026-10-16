FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY places-venues.js ./
COPY public ./public
COPY private ./private

# Photo Wall storage. In Coolify, mount a persistent volume at /app/data
# (or set UPLOADS_DIR to the mount path) or uploads are lost on redeploy.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT:-3000}/healthz || exit 1

CMD ["node", "server.js"]
