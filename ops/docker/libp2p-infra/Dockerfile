FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
VOLUME ["/data"]
# 4001 raw TCP, 4002 WebSockets - the default LISTEN_ADDRS pair. A client without a raw
# TCP transport (React Native) can only reach this over 4002, so both must be published.
EXPOSE 4001/tcp 4002/tcp
CMD ["node", "dist/main.js"]


