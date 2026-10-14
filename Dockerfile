# --------------------------------------------------------
# Base Stage
# --------------------------------------------------------
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

# --------------------------------------------------------
# Dependencies Stage
# --------------------------------------------------------
FROM base AS dependencies
COPY package*.json ./
COPY prisma ./prisma/
# argon2 ships no musl prebuilt binary: compile it from source on Alpine.
# Toolchain stays in this stage only, the runtime image copies node_modules.
RUN apk add --no-cache python3 make g++
RUN npm ci

# --------------------------------------------------------
# Build Stage
# --------------------------------------------------------
FROM base AS builder
COPY package*.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build
RUN npm prune --production

# --------------------------------------------------------
# Production Runner Stage
# --------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./

EXPOSE 3000
CMD ["node", "dist/src/main.js"]

