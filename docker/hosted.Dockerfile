# Hosted image: the MCP as a Claude connector on the home-server platform, behind
# Cloudflare Access (src/hosted/, see AGENTS.md "Install modes"). The root Dockerfile
# is upstream's HTTP mode and stays as it is.
#
# stdio-mode dependencies only (--omit=optional): no express, bcrypt or SQLite.
# Only what the hosted server runs is in the build context; see
# hosted.Dockerfile.dockerignore. Build from the repo root, with the submodule
# checked out:
#   docker build -f docker/hosted.Dockerfile -t anylist-mcp-hosted:dev .
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

WORKDIR /app

# .npmrc first: strict-allow-scripts makes the install fail on any unlisted install script
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=optional --omit=dev --no-audit --no-fund && npm cache clean --force

COPY anylist-js/package.json anylist-js/
COPY anylist-js/lib anylist-js/lib/
RUN test -f anylist-js/lib/index.js || \
    { echo "ERROR: anylist-js submodule is missing. Run: git submodule update --init" >&2; exit 1; }
COPY src ./src/

USER node

# Deployment defaults; the platform's compose file can override any of them. The
# ACCESS_* and ANYLIST_* settings come from the platform's secrets. Tokens are cached
# in /tmp, a tmpfs when the container runs read-only.
ENV NODE_ENV=production \
    TZ=America/Chicago \
    PORT=8000 \
    ANYLIST_TOKEN_DIR=/tmp

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/hosted/index.js"]
