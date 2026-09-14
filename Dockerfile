FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]