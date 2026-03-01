#!/bin/bash
# =============================================
# TinyWin — Deploy Script for Ubuntu 22.04+
# Run as root: sudo bash deploy.sh
# =============================================

set -e

APP_DIR="/opt/tinywin"
DOMAIN="tinywin.ru"

echo "=== [1/7] Installing system packages ==="
apt update
apt install -y python3 python3-venv python3-pip nginx certbot python3-certbot-nginx

echo "=== [2/7] Creating app directory ==="
mkdir -p $APP_DIR/data
cp -r backend $APP_DIR/
cp -r frontend $APP_DIR/

echo "=== [3/7] Creating Python virtualenv ==="
python3 -m venv $APP_DIR/venv
$APP_DIR/venv/bin/pip install --upgrade pip
$APP_DIR/venv/bin/pip install -r $APP_DIR/backend/requirements.txt

echo "=== [4/7] Setting permissions ==="
chown -R www-data:www-data $APP_DIR

echo "=== [5/7] Installing systemd service ==="
cp deploy/tinywin.service /etc/systemd/system/tinywin.service
systemctl daemon-reload
systemctl enable tinywin
systemctl start tinywin

echo "=== [6/7] Configuring Nginx ==="
cp deploy/nginx.conf /etc/nginx/sites-available/tinywin
ln -sf /etc/nginx/sites-available/tinywin /etc/nginx/sites-enabled/tinywin
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== [7/7] Setting up SSL (Let's Encrypt) ==="
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos --email support@$DOMAIN

echo ""
echo "========================================"
echo "  TinyWin deployed successfully!"
echo "  https://$DOMAIN"
echo "========================================"
echo ""
echo "Useful commands:"
echo "  systemctl status tinywin    — check status"
echo "  journalctl -u tinywin -f    — view logs"
echo "  systemctl restart tinywin   — restart app"
