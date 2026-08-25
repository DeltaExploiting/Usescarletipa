FROM node:20-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git cmake build-essential libssl-dev zlib1g-dev libminizip-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/zhlynn/zsign.git /tmp/zsign \
  && cmake -S /tmp/zsign -B /tmp/zsign/build \
  && cmake --build /tmp/zsign/build -j2 \
  && install -m 0755 /tmp/zsign/build/zsign /usr/local/bin/zsign \
  && rm -rf /tmp/zsign

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && chown -R node:node /app
COPY --chown=node:node server.js ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
