# Runs the app exactly the way `npm start` does locally -- tsx executing
# TypeScript directly, no separate compile step. This project has no
# production build artifact of its own (see README.md's "Local development"
# section): tsx and typescript are devDependencies, but they're required at
# runtime here, so this image intentionally does NOT use `npm ci --omit=dev`.
FROM node:20-slim

# Deliberately node:20-slim (Debian, glibc), not node:20-alpine -- alpine's
# musl libc has a real, documented history of incompatibility with
# better-sqlite3's prebuilt native binaries. Slim avoids that risk entirely
# and isn't meaningfully larger for a single-service image like this one.

WORKDIR /app

# Dependencies in their own layer so `npm ci` only re-runs when
# package*.json actually changes, not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# Everything else. .dockerignore excludes .env, .env.save, data/, node_modules,
# .git, and dist/ -- secrets and runtime state are never baked into the image;
# they're injected at container start (env_file) or mounted (data/ volume).
COPY . .

# The official Node image already ships a non-root "node" user -- use it
# instead of running as root inside the container.
#
# /app/data is created explicitly here, before chown, because it does NOT
# exist in the image otherwise: data/ is gitignored and excluded via
# .dockerignore (it's the SQLite runtime file), so `COPY . .` above never
# creates it. Without this, docker-compose.yml's named volume mounts onto
# a path with no prior ownership to inherit, Docker typically initializes
# it as root-owned, and the non-root "node" user below has no write
# permission -- openDatabase()'s first write fails and the container
# crash-loops on its very first deployment.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Uses Node's built-in fetch (stable since Node 18) rather than curl/wget,
# neither of which is installed in the slim image by default. Hits the
# cheap /health route (src/index.ts) -- confirms the HTTP server is
# accepting connections, not that every downstream dependency is reachable
# right now; see that route's own doc comment for why.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
