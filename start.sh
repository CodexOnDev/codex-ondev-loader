#!/bin/sh
set -eu
export HOME=/root
export PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export TERM=xterm-256color
export BB_TELEMETRY=false
export CODEX_HOME=/root/.codex
export NODE_OPTIONS=--max-old-space-size=768
mkdir -p /root /tmp /var/tmp /run
chmod 1777 /tmp /var/tmp 2>/dev/null || true
cd /opt/ondev
exec node src/server.js
