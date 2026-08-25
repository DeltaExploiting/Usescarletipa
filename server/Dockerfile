FROM node:20-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential libssl-dev zlib1g-dev libminizip-dev ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/zhlynn/zsign.git /tmp/zsign && cd /tmp/zsign && cmake -S . -B build && cmake --build build -j2 && install build/zsign /usr/local/bin/zsign && rm -rf /tmp/zsign
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["npm","start"]