FROM node:22.23.4-bookworm@sha256:2bd396628eceb5c999a6e43731fab69d5fb98b94ba9d9d90b5f64575c5178765

# Upgrade the runtime independently of the immutable base image.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
      amd64) node_arch=x64; node_sha=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce ;; \
      arm64) node_arch=arm64; node_sha=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b ;; \
      *) echo "Unsupported Node architecture: $arch" >&2; exit 1 ;; \
    esac \
    && curl --proto "=https" --tlsv1.2 -fsSL "https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-$node_arch.tar.xz" -o /tmp/node.tar.xz \
    && echo "$node_sha  /tmp/node.tar.xz" | sha256sum -c - \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/include/node \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && test "$(node --version)" = "v22.23.4" \
    && rm -f /tmp/node.tar.xz \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git postgresql-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
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
