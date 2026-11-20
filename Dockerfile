FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY artifacts ./artifacts
EXPOSE 4405
# required env: GATE_ADDRESS TOKEN_ADDRESS RELAYER_KEY RPC_URL (see .env.example)
CMD ["node", "src/server.mjs"]
