FROM node:20-slim

# ffmpeg for trimming/merging, python3+pip for yt-dlp, curl to install yt-dlp binary
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp as a standalone binary (kept up to date independent of apt)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
