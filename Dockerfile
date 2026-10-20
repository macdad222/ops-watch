FROM node:24-alpine
WORKDIR /app
COPY triage.mjs lib.mjs notify.mjs loki-tail.mjs receiver.mjs ticker.sh ./
COPY rules.json honeytokens.json ./
COPY jev-gate.mjs ./jev/jev-gate.mjs
# placeholder files so single-file bind mounts (config/, secrets/) attach as files not dirs
RUN mkdir -p data/processed logs jev && touch jev/gates.json jev/ts-lane-id.txt jev/model-pin.txt jev/decisions.log && chmod +x ticker.sh
CMD ["sh", "./ticker.sh"]
