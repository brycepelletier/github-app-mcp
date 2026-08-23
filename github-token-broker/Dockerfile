FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev \
    && npm cache clean --force

COPY server.mjs ./

USER node

CMD ["node", "server.mjs"]