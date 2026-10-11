# Engineering Board in Docker. Build from the unzipped board folder (the one with app/ in it):
#
#   docker compose -f linux/docker-compose.yml up -d --build
#
# Nothing is downloaded from npm: the board has no dependencies beyond Node.js itself.
FROM node:22-slim

WORKDIR /board
COPY app ./app

# Data (board.db and backups) lives in a volume so it survives rebuilding the container.
# The container runs as root so it can write to a bind-mounted host folder without
# permission fiddling; it only ever touches /data.
ENV EB_DATA_DIR=/data \
    EB_HOST=0.0.0.0 \
    EB_PORT=8080 \
    NODE_ENV=production
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "app/server.mjs"]
