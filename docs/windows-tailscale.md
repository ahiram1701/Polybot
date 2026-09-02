# Ver la UI de Polybot en el celular por Tailscale (Windows)

> **Alcance: despliegue nativo de Windows.** Con Docker el arranque es `docker compose up -d` en vez del
> doble clic, y `POLYBOT_UI_HOST` ya vale `0.0.0.0` dentro del contenedor: lo que hay que cambiar es la
> publicación del puerto en `docker-compose.yml`. El resto de la guía (instalar Tailscale, la dirección
> `100.x`) vale igual. Ver [docker.md](docker.md).

Objetivo: ejecutar Polybot en tu PC con un **doble clic** y abrir la UI desde el celular. Polybot corre en tu PC Windows y la UI se ve desde otro dispositivo por Tailscale.

> La UI **no tiene login**. Con la configuración de abajo escucha en todas las interfaces, así que es accesible tanto desde esta PC como desde tu tailnet (y tu LAN). Si tu red local no es de confianza, mirá la sección "Solo tailnet" al final.

## Uso normal (lo único que haces siempre)

1. **Doble clic** en `INICIAR-POLYBOT.cmd` (arranca la simulación) o `ABRIR-POLYBOT.cmd` (abre la UI sin arrancar el bot).
   - La ventana te muestra la dirección para el celular, por ejemplo:
     ```
     EN TU CELULAR (con Tailscale activo) abre:
         http://100.99.240.111:8787
     ```
   - En esta PC el navegador se abre solo en `http://127.0.0.1:8787`.
2. En el **celular**, con la app de **Tailscale activada** (misma cuenta/tailnet), abrí esa dirección `http://100.x:8787`.
3. Para detener todo: cerrá la ventana negra (o `Ctrl+C`).

Eso es todo. No hay pasos extra cada vez.

## Configuración (una sola vez)

Ya está hecho en este repo, pero por si lo armás de cero en otra PC:

1. Instalá Tailscale en la PC y en el celular, con la **misma cuenta**.
2. Conseguí la IP de Tailscale de la PC:
   ```powershell
   tailscale ip -4
   # ej. 100.99.240.111  (estable para este equipo)
   ```
3. En `.env`:
   ```env
   POLYBOT_UI_HOST=0.0.0.0
   POLYBOT_UI_PORT=8787
   POLYBOT_PUBLIC_URL=http://100.99.240.111:8787
   ```
   - `0.0.0.0` hace que escuche en todas las interfaces → funciona el navegador local **y** el celular a la vez.
   - `POLYBOT_PUBLIC_URL` es solo la dirección que se muestra en el log y en los avisos de Telegram.

### Windows Firewall (posible, una sola vez)
La primera vez que el celular conecte, Windows puede pedir permitir `Node.js` en el firewall. Pulsá **Permitir acceso**. Si no aparece y el celular no conecta, creá una regla de entrada para el puerto `8787`.

## Solo tailnet (más seguro, sin exposición a la LAN)

Si NO querés que la UI sea visible en tu red local (solo por Tailscale), cambiá en `.env`:
```env
POLYBOT_UI_HOST=100.99.240.111
```
Contras: el auto-abrir local del lanzador (`http://127.0.0.1:8787`) deja de funcionar; en esta misma PC tendrías que abrir `http://100.99.240.111:8787`. El celular sigue funcionando igual.

> Nunca uses `tailscale funnel` con esta UI: publicaría la interfaz (sin login) en internet.
