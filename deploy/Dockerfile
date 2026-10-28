# The lab API with the console it serves. Simulated model only: no API keys needed or read.
FROM node:22.22-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/agent/package.json packages/agent/
COPY packages/skyline/package.json packages/skyline/
COPY packages/lab/package.json packages/lab/
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
RUN npm ci --no-audit --no-fund
COPY . .
RUN cd apps/console && npx vite build

FROM node:22.22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 CXLAB_ROOT=/app
COPY --from=build /app /app
USER node
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "apps/api/src/main.ts"]
