FROM node:20-alpine

WORKDIR /app

# Copy monorepo manifests first for dependency install layer caching
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json

# Copy only the workspaces needed by backend runtime
COPY apps/server apps/server
COPY packages/shared packages/shared

# Install only server + shared workspace dependencies
RUN npm install --omit=dev --workspace=packages/shared --workspace=apps/server --include-workspace-root

ENV NODE_ENV=production

WORKDIR /app/apps/server

CMD ["npm", "run", "start"]
