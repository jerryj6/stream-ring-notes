FROM node:22-bookworm

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o node -g node /app/data

COPY tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/
RUN npm run build

ENV NODE_ENV=production HOST=0.0.0.0 STREAM_HOST=0.0.0.0 IG_CHROMIUM_SANDBOX=false
EXPOSE 4317 8779
USER node
CMD ["node", "dist/index.js"]
