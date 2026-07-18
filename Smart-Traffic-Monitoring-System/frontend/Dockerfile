ARG NODE_VERSION=20.19.0
ARG PNPM_VERSION=9.14.4

# ---------- Build stage ----------
FROM node:${NODE_VERSION}-alpine AS build

RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /frontend

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

COPY . .

# Vite bakes these values into the static bundle at build time.
ARG VITE_API_HTTP_BASE=http://localhost:8000
ARG VITE_API_WS_BASE=ws://localhost:8000
ENV VITE_API_HTTP_BASE=${VITE_API_HTTP_BASE}
ENV VITE_API_WS_BASE=${VITE_API_WS_BASE}

RUN pnpm build

# ---------- Runtime stage ----------
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /frontend/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
