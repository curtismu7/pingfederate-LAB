# PingFederate Lab in Docker (OrbStack). Build the web app, then run the server alone as the non-root node user.
FROM node:26-alpine AS build
WORKDIR /lab
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY web web
RUN npm run build -w web

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /lab
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --omit=dev -w server --include-workspace-root=false --no-audit --no-fund && npm cache clean --force
COPY server/src server/src
COPY stories stories
COPY --from=build /lab/web/dist web/dist
RUN mkdir -p /config && chown node:node /config && chmod 700 /config
USER node
EXPOSE 5400
CMD ["node", "server/src/index.js"]
