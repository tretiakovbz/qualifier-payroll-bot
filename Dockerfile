FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
CMD ["bun", "run", "src/index.ts"]
