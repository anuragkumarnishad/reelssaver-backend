FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN python3 -m venv /opt/story-venv
COPY requirements-story.txt ./
RUN /opt/story-venv/bin/pip install --no-cache-dir -r requirements-story.txt

COPY . .

ENV NODE_ENV=production \
    PORT=8080 \
    STORY_PYTHON_COMMAND=/opt/story-venv/bin/python

USER node
EXPOSE 8080
CMD ["npm", "start"]
