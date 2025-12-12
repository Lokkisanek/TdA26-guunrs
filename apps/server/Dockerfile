FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./
COPY views ./views
COPY public ./public

# Create uploads directory
RUN mkdir -p /app/uploads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
