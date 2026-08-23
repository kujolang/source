FROM node:20.19.5-bookworm@sha256:ba36e9b2705008e63e354214f0e3011c528af9df2ca13ac2bd2c0114650302e6

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git postgresql-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /var/lib/source/data /var/lib/source/git \
  && chown -R node:node /app /var/lib/source
USER node

ENV NODE_ENV=production \
    SOURCE_DATA=/var/lib/source/data \
    SOURCE_GIT_ROOT=/var/lib/source/git
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/source.js", "--store", "postgres", "serve", "--host", "0.0.0.0", "--port", "8787", "--writer-lease"]
