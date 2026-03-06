FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source code and assets
COPY src ./src
COPY public ./public
COPY tsconfig.json ./

# Create uploads directory
RUN mkdir -p /app/uploads

ENV PORT=3000
EXPOSE 3000

# Run Prisma migrations and start with tsx
CMD npx prisma migrate deploy && npx tsx src/index.ts
