FROM node:alpine
MAINTAINER Tal Maoz <tmaoz@cisco.com>

ENV NODE_ENV production

RUN set -x \
    && apk add --no-cache git build-base tini \
    && mkdir -p /usr/src/app

WORKDIR /usr/src/app

COPY package.json index.js timeSeries.js backgroundTask.js logger.js websocket.js layoutDB.js /usr/src/app/

RUN set -x \
    && npm install -q \
    && npm prune \
    && apk del --no-cache git build-base

EXPOSE 3000

ENTRYPOINT [ "/sbin/tini", "--", "npm", "start" ]
