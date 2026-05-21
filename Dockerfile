# Single image, two run modes.
# - `npm run start` (CMD default)  -> Next.js web portal
# - `npm run bot:prod`             -> discord.js scheduler worker
#
# docker-compose runs two containers off this image with different commands.

# --- Base selection -------------------------------------------------------
# Two parallel base stages; one is selected via the CORP_BASE build arg.
# Each stage is independent — they both run `apk add` directly, with base-corp
# injecting the corp CA *before* apk so the package fetch can succeed behind
# a TLS-intercepting proxy. BuildKit only builds the stage that's referenced
# below, so the COPY of corp-chain.pem in base-corp never fires in CI.
#
# Default (CI / prod / non-corp networks): base-clean.
# Local dev behind a corp MITM proxy:  set CORP_BASE=base-corp in your .env
# (docker-compose reads it automatically and passes it as --build-arg).
#
# Global ARG: must be declared before any FROM that uses it. Compose
# overrides via build.args; the default kicks in when CORP_BASE is unset.
ARG CORP_BASE=base-clean

FROM node:20-alpine AS base-clean
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

FROM node:20-alpine AS base-corp
WORKDIR /app
COPY corp-chain.pem /tmp/corp-chain.pem
RUN cat /tmp/corp-chain.pem >> /etc/ssl/cert.pem \
 && apk add --no-cache openssl libc6-compat ca-certificates \
 && cp /tmp/corp-chain.pem /usr/local/share/ca-certificates/corp-chain.crt \
 && update-ca-certificates \
 && rm /tmp/corp-chain.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

FROM ${CORP_BASE} AS base

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
