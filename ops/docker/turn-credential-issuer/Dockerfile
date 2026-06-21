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
COPY --from=build /app/dist ./dist
# Stateless service, built from Node built-ins only — no runtime node_modules to copy.
EXPOSE 8080/tcp
CMD ["node", "dist/main.js"]
