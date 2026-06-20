# ScrubCheck on Cloud Run
FROM node:20-slim
WORKDIR /app

# Install production deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

ENV NODE_ENV=production
# Cloud Run injects PORT (8080); server.js already reads process.env.PORT.
EXPOSE 8080
CMD ["node", "server.js"]
