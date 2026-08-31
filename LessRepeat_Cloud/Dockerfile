# Stage 1: Build the client-side assets
FROM node:20-alpine AS builder

WORKDIR /app

# Copy lockfiles and workspace configs
COPY dashboard/package.json dashboard/pnpm-lock.yaml dashboard/pnpm-workspace.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy src and scripts to build the client bundle (esbuild)
COPY dashboard/src ./src
COPY dashboard/scripts ./scripts
COPY dashboard/public ./public
RUN pnpm run build

# Stage 2: Prepare final runner image
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY dashboard/package.json dashboard/pnpm-lock.yaml dashboard/pnpm-workspace.yaml ./
RUN npm install -g pnpm && pnpm install --prod --frozen-lockfile

# Copy runtime server files and built assets
COPY dashboard/server.js ./
COPY dashboard/lib ./lib
COPY --from=builder /app/public ./public

# Set production defaults
EXPOSE 8787
ENV PORT=8787
ENV DEPLOY_MODE=CLOUD
ENV NODE_ENV=production

CMD ["node", "server.js"]
