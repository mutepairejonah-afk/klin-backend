FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates git python3 python3-pip python3-venv ripgrep jq sqlite3 \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 --shell /bin/bash kiln \
  && mkdir -p /workspace /tmp/kiln \
  && chown -R kiln:kiln /workspace /tmp/kiln

USER kiln
WORKDIR /workspace

CMD ["sleep", "infinity"]
