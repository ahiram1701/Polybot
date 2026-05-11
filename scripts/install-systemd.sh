#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this script as the deploy user, not as root. It will use sudo only for systemd files."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required and was not found in PATH."
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Node.js 20+ is required. Found: $(node --version)"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required and was not found in PATH."
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${POLYBOT_SERVICE_NAME:-polybot}"
SERVICE_USER="${POLYBOT_SERVICE_USER:-$(id -un)}"
SERVICE_GROUP="${POLYBOT_SERVICE_GROUP:-$(id -gn)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

cd "${APP_DIR}"

echo "Installing dependencies and building Polybot..."
npm ci
npm run build
npm run ui:build
mkdir -p "${APP_DIR}/data"

echo "Writing ${UNIT_PATH}..."
sudo tee "${UNIT_PATH}" >/dev/null <<UNIT
[Unit]
Description=Polybot UI 24/7
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${NODE_BIN} ${APP_DIR}/dist/src/ui/index.js --static
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"

echo "Polybot service is active."
echo "Check logs with: journalctl -u ${SERVICE_NAME} -f"
