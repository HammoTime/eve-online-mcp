FROM node:26.9.0-bookworm-slim AS development

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

USER node

CMD ["sleep", "infinity"]

