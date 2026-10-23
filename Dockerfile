FROM node:24-alpine
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=${GIT_SHA}
WORKDIR /app
# v2 (2026-10-23 deploy-drift fix): COPY * — every runtime file ships in the image.
# Previously assess.mjs was docker-cp'd onto the live container only; a plain rebuild
# silently dropped it. Globs are top-level; docs/, test/, ml/ are host-side only.
COPY *.mjs ./
COPY *.json ./
COPY ticker.sh daily-trim.sh ./
COPY jev-gate.mjs ./jev/jev-gate.mjs
# placeholder files so single-file bind mounts (config/, secrets/) attach as files not dirs
RUN mkdir -p data/processed logs jev config && touch jev/gates.json jev/ts-lane-id.txt jev/model-pin.txt jev/decisions.log config/opswatch.json && chmod +x ticker.sh
CMD ["sh", "./ticker.sh"]
