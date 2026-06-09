FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Seed runs at container startup so it can write to the Railway volume
# (building with seed here would write to image layer, not the persistent volume)

FROM node:20-alpine AS runner

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/database ./database
COPY --from=builder /app/src/lib ./src/lib

ENV NODE_ENV=production

EXPOSE 3001

# Seed on first run if DB doesn't exist, then start
CMD ["sh", "-c", "[ ! -f database/citywide.db ] && node -e \"require('child_process').execSync('npx ts-node database/seed.ts', {stdio:'inherit'})\" || true; node dist/index.js"]
