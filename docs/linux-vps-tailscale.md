# Polybot En VPS Linux Con Tailscale

Esta guia deja Polybot corriendo 24/7 en un VPS Ubuntu/Debian, con la UI accesible desde iPhone por Tailscale. Live no arranca solo: lo inicias manualmente desde la UI.

## 1. Instalar base

```bash
sudo apt update
sudo apt install -y curl git ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

Clona o copia Polybot al VPS y entra al directorio:

```bash
cd ~/Polybot
npm ci
cp .env.example .env
```

Edita `.env`:

```env
MODE=sim
POLYBOT_UI_HOST=0.0.0.0
POLYBOT_UI_PORT=8787
POLYBOT_PUBLIC_URL=http://TU-IP-TAILSCALE:8787
ENABLED_MARKETS=BTC,ETH,DOGE
```

Para live, agrega tambien `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_SIGNATURE_TYPE` y `POLYMARKET_FUNDER_ADDRESS`. La UI no arranca live automaticamente.

## 2. Configurar Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4
```

Instala Tailscale en el iPhone, inicia sesion en la misma tailnet y abre:

```text
http://TU-IP-TAILSCALE:8787
```

## 3. Bloquear acceso publico

Permite SSH y Tailscale, pero no publiques `8787` a internet:

```bash
sudo ufw allow OpenSSH
sudo ufw allow in on tailscale0 to any port 8787 proto tcp
sudo ufw deny 8787/tcp
sudo ufw enable
sudo ufw status verbose
```

## 4. Telegram opcional

Crea un bot con BotFather y consigue tu `chat_id`. En `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:token
TELEGRAM_CHAT_ID=123456789
POLYBOT_PUBLIC_URL=http://TU-IP-TAILSCALE:8787
```

Polybot avisara cuando la UI quede lista, cuando el bot arranque o se detenga, cuando haya errores criticos y cuando el autoajuste aplique cambios.

## 5. Build e instalacion 24/7

```bash
npm run build
npm run ui:build
npm run service:install
```

El servicio se llama `polybot` por defecto. Comandos utiles:

```bash
sudo systemctl status polybot
journalctl -u polybot -f
sudo systemctl restart polybot
sudo systemctl stop polybot
```

El servicio ejecuta:

```bash
node dist/src/ui/index.js --static
```

Eso levanta la UI, pero no inicia live. Desde el iPhone puedes entrar por Tailscale, revisar estado y pulsar Live cuando estes listo.

## 6. Actualizar Polybot

```bash
cd ~/Polybot
git pull
npm ci
npm run build
npm run ui:build
sudo systemctl restart polybot
```

## 7. Checklist rapido

- `systemctl status polybot` aparece activo.
- `journalctl -u polybot -f` muestra `Polybot UI listening`.
- Desde iPhone abre `POLYBOT_PUBLIC_URL`.
- Telegram recibe `UI lista` si configuraste token/chat.
- Despues de reiniciar el VPS, la UI vuelve sola y live sigue apagado hasta que lo actives.
