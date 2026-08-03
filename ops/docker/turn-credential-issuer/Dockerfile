FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
# NOTE: no lock file is committed (same as ../libp2p-infra), so the `^` ranges in
# package.json resolve at build time. If a dependency ever ships a breaking minor
# and the image stops building, commit a package-lock.json and `npm ci` here.
RUN npm install
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
# @libp2p/crypto is a runtime dependency (peer-assertion verification), so the
# install tree must ship — same as ../libp2p-infra/Dockerfile.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080/tcp
CMD ["node", "dist/main.js"]
