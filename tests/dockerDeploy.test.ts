import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Los artefactos de despliegue se afirman como cualquier otra pieza que decide sobre dinero, igual que
 * `systemdScript.test.ts` hace con el instalador de systemd.
 *
 * No comprueban que la imagen construya —eso necesita un demonio de Docker— sino las INVARIANTES que,
 * al romperse, no dan error: un puerto publicado de mas no falla, arranca y queda expuesto; un `.env`
 * sin excluir no falla, se hornea con la clave dentro; un volumen que falta no falla, borra el ledger
 * en el siguiente build. Los tres son silenciosos, que es justo el patron que este proyecto persigue.
 */
async function leer(nombre: string): Promise<string> {
  return readFile(join(process.cwd(), nombre), "utf8");
}

describe("Dockerfile", () => {
  it("arranca la UI estatica igual que el servicio de systemd", async () => {
    const dockerfile = await leer("Dockerfile");

    expect(dockerfile).toContain("dist/src/ui/index.js");
    expect(dockerfile).toContain("--static");
    // `--static` sirve `dist/client`, que resuelve desde process.cwd(): si el WORKDIR no es /app, la
    // UI responde 404 en la raiz con el servidor perfectamente vivo.
    expect(dockerfile).toContain("WORKDIR /app");
  });

  it("escucha en todas las interfaces DEL CONTENEDOR", async () => {
    // Sin esto el servidor se queda en el 127.0.0.1 interno y el puerto publicado no lleva a ningun
    // sitio: parece que la UI no arranco. Quien acota el acceso es la publicacion del puerto.
    expect(await leer("Dockerfile")).toContain("POLYBOT_UI_HOST=0.0.0.0");
  });

  it("fija TZ=UTC", async () => {
    // Las recompensas se abonan ~00:45 UTC y el limite de gasto es por dia. Con otro huso, el contador
    // del bot y el del exchange dejan de hablar del mismo dia y ninguno avisa.
    expect(await leer("Dockerfile")).toContain("TZ=UTC");
  });

  it("declara el supervisor para que la UI no ofrezca el toggle del watchdog", async () => {
    expect(await leer("Dockerfile")).toContain("POLYBOT_SUPERVISOR=compose");
  });

  it("no ejecuta como root", async () => {
    expect(await leer("Dockerfile")).toMatch(/^USER node$/m);
  });

  it("no hornea secretos en una capa", async () => {
    const dockerfile = await leer("Dockerfile");
    expect(dockerfile).not.toContain("POLYMARKET_PRIVATE_KEY");
    expect(dockerfile).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(dockerfile).not.toMatch(/^COPY \.env\b/m);
  });
});

describe(".dockerignore", () => {
  it("excluye el .env", async () => {
    const ignore = await leer(".dockerignore");
    // Una capa es inmutable: una clave copiada aqui no se borra con un `rm` posterior, sigue en la capa
    // donde entro y viaja con la imagen al publicarla.
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
  });

  it("excluye el estado y los artefactos de build", async () => {
    const ignore = await leer(".dockerignore");
    // `data/` fuera, o cada build reintroduciria un ledger viejo y el P&L mentiria.
    expect(ignore).toMatch(/^data\/$/m);
    // `node_modules/` fuera, o se mezclarian binarios de Windows con un runtime Linux.
    expect(ignore).toMatch(/^node_modules\/$/m);
    expect(ignore).toMatch(/^dist\/$/m);
  });
});

describe("docker-compose.yml", () => {
  it("publica la UI SOLO en loopback", async () => {
    const compose = await leer("docker-compose.yml");
    // La UI no tiene autenticacion y expone endpoints que mueven dinero real (arrancar live, cambiar
    // modos, resetear estado). "8787:8787" a secas la deja en todas las interfaces de la maquina.
    expect(compose).toContain('"127.0.0.1:8787:8787"');
    expect(compose).not.toMatch(/^\s*-\s*"8787:8787"/m);
    expect(compose).not.toMatch(/^\s*-\s*"0\.0\.0\.0:8787:8787"/m);
  });

  it("persiste data/ en los DOS servicios", async () => {
    const compose = await leer("docker-compose.yml");
    // trades.jsonl es la fuente de verdad del P&L. Sin volumen, `up --build` lo borra.
    // Y el archivador lee el FICHERO, no la API: sin el mismo montaje no ve nada que archivar.
    expect(compose.match(/\.\/data:\/app\/data/g) ?? []).toHaveLength(2);
  });

  it("es el supervisor del proceso", async () => {
    const compose = await leer("docker-compose.yml");
    // `/api/system/restart` hace process.exit(0) contando con que alguien lo levante.
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).toContain("POLYBOT_SUPERVISOR=compose");
  });

  it("corre el archivador de analitica", async () => {
    const compose = await leer("docker-compose.yml");
    // Sin el, analytics.jsonl RECICLA a las ~2 semanas (tope de 10.000 con borrado FIFO) y no hay
    // historia suficiente para validar nada fuera de muestra.
    expect(compose).toContain("dist/src/archiveAnalytics.js");
    expect(compose).toContain("polybot-archivador");
  });

  it("fija TZ=UTC en los dos servicios", async () => {
    const compose = await leer("docker-compose.yml");
    expect(compose.match(/TZ=UTC/g) ?? []).toHaveLength(2);
  });

  it("no lleva secretos escritos", async () => {
    const compose = await leer("docker-compose.yml");
    expect(compose).not.toContain("POLYMARKET_PRIVATE_KEY");
    expect(compose).toContain("env_file");
  });

  it("el archivador NO hereda el healthcheck de la UI", async () => {
    const compose = await leer("docker-compose.yml");
    // La imagen sondea la UI en 8787 y ese contenedor no levanta servidor: heredarlo lo deja
    // `unhealthy` para siempre y convierte `docker compose ps` en ruido, que es donde hay que poder ver
    // de un vistazo si el bot esta ciego. Comprobado en un `up` real antes de existir esta linea.
    expect(compose).toMatch(/healthcheck:\s*\n\s*disable:\s*true/);
  });
});

describe("data/ sobrevive a un git clone", () => {
  it("no queda a merced de que Docker lo cree como root", async () => {
    // Docker crea el origen de un bind mount como ROOT cuando no existe en el host, y el contenedor
    // corre como uid 1000. Sin `data/` ya presente, la primera pasada del archivador muere con EACCES
    // y el sintoma es el peor posible: el bot parece sano y no persiste nada. Paso de verdad en el
    // primer `docker compose up` de esta maquina.
    const ignore = await leer(".gitignore");
    expect(ignore).toMatch(/^data\/\*$/m);
    expect(ignore).toMatch(/^!data\/\.gitkeep$/m);
    await expect(leer("data/.gitkeep")).resolves.toContain("bind mount");
  });
});
