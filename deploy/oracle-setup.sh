#!/usr/bin/env bash
# One-command setup for Market Brain on a fresh Linux server (Oracle Cloud Always Free).
# Works on Oracle Linux / RHEL-like (dnf) and Ubuntu / Debian (apt).
# Installs Node.js, the bot as a service that restarts on its own, and Caddy for automatic HTTPS.
# Safe to run again: it updates the code and restarts the bot.
set -euo pipefail

REPO="https://github.com/danidindan1/market-brain.git"
DIR="/opt/market-brain"
USER_NAME="$(id -un)"
ARCH="$(uname -m)"; case "$ARCH" in aarch64|arm64) CADDY_ARCH=arm64;; *) CADDY_ARCH=amd64;; esac

if command -v dnf >/dev/null; then PM=dnf; elif command -v apt-get >/dev/null; then PM=apt; else echo "Unsupported system"; exit 1; fi

echo "==> Installing Node.js and git ($PM)"
if [ "$PM" = dnf ]; then
  sudo dnf install -y git curl tar
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs
  fi
else
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -y
  sudo apt-get install -y curl git ca-certificates
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi

echo "==> Getting the code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
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
ExecStart=$(command -v node) --max-old-space-size=900 server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable market-brain >/dev/null
sudo systemctl restart market-brain

echo "==> Installing Caddy (automatic HTTPS)"
if ! [ -x /usr/local/bin/caddy ]; then
  sudo curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$CADDY_ARCH" -o /usr/local/bin/caddy
  sudo chmod +x /usr/local/bin/caddy
fi
id caddy >/dev/null 2>&1 || sudo useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
sudo mkdir -p /etc/caddy
sudo tee /etc/systemd/system/caddy.service >/dev/null <<UNIT
[Unit]
Description=Caddy web server
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Opening web ports in the server firewall"
if command -v firewall-cmd >/dev/null && sudo firewall-cmd --state >/dev/null 2>&1; then
  sudo firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  sudo firewall-cmd --reload >/dev/null
fi
if command -v iptables >/dev/null; then
  for p in 80 443; do
    sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null; fi
fi

echo "==> Setting up HTTPS"
IP="$(curl -fsS https://api.ipify.org)"
HOST="${IP//./-}.sslip.io"   # free hostname that points at this server's IP, so no domain is needed
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$HOST {
  reverse_proxy localhost:4600
}
CADDY
sudo systemctl daemon-reload
sudo systemctl enable caddy >/dev/null
sudo systemctl restart caddy

echo
echo "Done. The bot is starting (learning from history takes a few minutes)."
echo "Open:  https://$HOST"
