# syntax=docker/dockerfile:1
# VNStock Sim — 1 image gồm API (Express + Socket.io) và giao diện đã build (API phục vụ luôn file tĩnh).
#   docker build -t vnstock-sim .
#   docker run -p 4000:4000 -e JWT_SECRET=... -e PUBLIC_URL=http://localhost:4000 -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... vnstock-sim
# Chạy đầy đủ (Postgres + HTTPS + sao lưu): xem docker-compose.yml và docs/DEPLOY.md

ARG NODE_VERSION=24

# ---------- cài thư viện (tận dụng cache khi chỉ đổi mã nguồn) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund

# ---------- build giao diện ----------
FROM deps AS build
COPY shared shared
COPY frontend frontend
RUN npm run build -w frontend

# ---------- image chạy thật: chỉ thư viện runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY shared/src shared/src
COPY backend/tsconfig.json backend/
COPY backend/src backend/src
COPY backend/migrations backend/migrations
COPY backend/scripts backend/scripts
COPY --from=build /app/frontend/dist frontend/dist

WORKDIR /app/backend
# DATA_DIR chỉ dùng khi không có DATABASE_URL (PGlite nhúng) — gắn volume vào /app/backend/data
ENV PORT=4000 \
    FRONTEND_DIST=../frontend/dist \
    DATA_DIR=/app/backend/data/pgdata
RUN mkdir -p /app/backend/data && chown -R node:node /app/backend/data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Chạy trực tiếp bằng node (không qua tiến trình con) để nhận đúng SIGTERM khi docker stop → tắt êm
CMD ["node", "--import", "tsx", "src/index.ts"]
