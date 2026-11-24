# Portable image for hosts other than Render
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY src ./src
COPY ui ./ui
COPY assets ./assets
COPY vite.*.config.ts ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY assets ./assets
EXPOSE 8787
CMD ["node", "dist/index.js"]
