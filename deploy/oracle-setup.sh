#!/usr/bin/env bash
# One-command setup for Market Brain on a fresh Ubuntu server (Oracle Cloud Always Free).
# Installs Node.js, the bot as a service that restarts on its own, and Caddy for automatic HTTPS.
# Safe to run again: it updates the code and restarts the bot.
set -euo pipefail

REPO="https://github.com/danidindan1/market-brain.git"
DIR="/opt/market-brain"
USER_NAME="$(id -un)"

echo "==> Installing Node.js, git and Caddy"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo "==> Getting the code"
if [ -d "$DIR/.git" ]; then
  sudo -u "$USER_NAME" git -C "$DIR" pull --ff-only
else
  sudo mkdir -p "$DIR" && sudo chown "$USER_NAME" "$DIR"
  git clone "$REPO" "$DIR"
fi
cd "$DIR" && npm ci --omit=dev

echo "==> Installing the bot as a service"
sudo tee /etc/systemd/system/market-brain.service >/dev/null <<UNIT
[Unit]
Description=Market Brain signal bot
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$DIR
Environment=PORT=4600
ExecStart=/usr/bin/node --max-old-space-size=600 server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable market-brain >/dev/null
sudo systemctl restart market-brain

echo "==> Opening web ports in the server firewall"
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null; fi

echo "==> Setting up HTTPS"
IP="$(curl -fsS https://api.ipify.org)"
HOST="${IP//./-}.sslip.io"   # free hostname that points at this server's IP, so no domain is needed
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$HOST {
  reverse_proxy localhost:4600
}
CADDY
sudo systemctl restart caddy

echo
echo "Done. The bot is starting (learning from history takes a few minutes)."
echo "Open:  https://$HOST"
