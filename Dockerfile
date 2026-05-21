# Single image, two run modes.
# - `npm run start` (CMD default)  -> Next.js web portal
# - `npm run bot:prod`             -> discord.js scheduler worker
#
# docker-compose runs two containers off this image with different commands.

FROM node:20-alpine AS base
WORKDIR /app

# Local-only: trust corp MITM CA before any network ops.
# Alpine's apk reads /etc/ssl/cert.pem; node reads NODE_EXTRA_CA_CERTS.
# Remove this block before deploying to AWS (or gate it with a build arg).
COPY corp-chain.pem /tmp/corp-chain.pem
RUN cat /tmp/corp-chain.pem >> /etc/ssl/cert.pem \
 && apk add --no-cache openssl libc6-compat ca-certificates \
 && cp /tmp/corp-chain.pem /usr/local/share/ca-certificates/corp-chain.crt \
 && update-ca-certificates \
 && rm /tmp/corp-chain.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# --- deps ---
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

# --- builder ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# --- runner ---
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs

EXPOSE 3000
CMD ["npm", "run", "start"]
