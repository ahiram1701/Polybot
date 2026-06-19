# Polybot En VPS Linux Con Tailscale

Esta guia deja Polybot corriendo 24/7 en un VPS Ubuntu/Debian, con la UI accesible desde iPhone por Tailscale. Live no arranca solo: lo inicias manualmente desde la UI.

## 1. Crear usuario e instalar base

No ejecutes Polybot como `root`. En un VPS nuevo, usa `root` solo para instalar paquetes base y crear un usuario de despliegue. El servicio quedara corriendo con ese usuario normal.

```bash
sudo apt update
sudo apt install -y curl git ufw rsync
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
sudo adduser polybot
sudo usermod -aG sudo polybot
su - polybot
```

## 2. Copiar o clonar Polybot

Desde el usuario `polybot`, deja el proyecto en `/home/polybot/Polybot`.

Si usas Git:

```bash
git clone TU_REPO_POLYBOT ~/Polybot
cd ~/Polybot
```

Si ya copiaste Polybot dentro de `/root`, vuelve temporalmente a una sesion con sudo/root y muevelo:

```bash
sudo mkdir -p /home/polybot/Polybot
sudo rsync -a --exclude node_modules /root/Polybot/Polybot/ /home/polybot/Polybot/
sudo chown -R polybot:polybot /home/polybot/Polybot
su - polybot
cd ~/Polybot
```

Instala dependencias y crea `.env` desde el usuario `polybot`:

```bash
npm ci
cp .env.example .env
```

Edita `.env`:

```env
MODE=sim
POLYBOT_UI_HOST=0.0.0.0
POLYBOT_UI_PORT=8788
POLYBOT_PUBLIC_URL=http://TU-IP-TAILSCALE:8788
ENABLED_MARKETS=BTC,ETH,DOGE
```

Para live, agrega tambien `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_SIGNATURE_TYPE` y `POLYMARKET_FUNDER_ADDRESS`. La UI no arranca live automaticamente.

## 3. Configurar Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4
```

Instala Tailscale en el iPhone, inicia sesion en la misma tailnet y abre:

```text
http://TU-IP-TAILSCALE:8788
```

## 4. Bloquear acceso publico

Permite SSH y Tailscale, pero no publiques `8788` a internet:

```bash
sudo ufw allow OpenSSH
sudo ufw allow in on tailscale0 to any port 8788 proto tcp
sudo ufw deny 8788/tcp
sudo ufw enable
sudo ufw status verbose
```

## 5. Telegram opcional

Crea un bot con BotFather y consigue tu `chat_id`. En `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:token
TELEGRAM_CHAT_ID=123456789
POLYBOT_PUBLIC_URL=http://TU-IP-TAILSCALE:8788
```

Polybot avisara cuando la UI quede lista, cuando el bot arranque o se detenga, cuando haya errores criticos y cuando el autoajuste aplique cambios.

## 6. Build e instalacion 24/7

Este paso debe ejecutarse como usuario `polybot`, no como `root`. El script usa `sudo` internamente solo para crear/actualizar el archivo de `systemd`.

```bash
whoami
npm run build
npm run ui:build
npm run service:install
```

`whoami` debe mostrar `polybot` o tu usuario de despliegue. Si muestra `root`, deten el paso y cambia de usuario:

```bash
su - polybot
cd ~/Polybot
npm run service:install
```

Si aparece este mensaje:

```text
Run this script as the deploy user, not as root.
```

no significa que el build fallo. Significa que el servicio no se instalo porque estabas en `root`.

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

## 7. Actualizar Polybot

Actualiza tambien desde el usuario `polybot`:

```bash
cd ~/Polybot
git pull
npm ci
npm run build
npm run ui:build
sudo systemctl restart polybot
```

## 8. Checklist rapido

- `systemctl status polybot` aparece activo.
- `journalctl -u polybot -f` muestra `Polybot UI listening`.
- Desde iPhone abre `POLYBOT_PUBLIC_URL`.
- Telegram recibe `UI lista` si configuraste token/chat.
- Despues de reiniciar el VPS, la UI vuelve sola y live sigue apagado hasta que lo actives.
