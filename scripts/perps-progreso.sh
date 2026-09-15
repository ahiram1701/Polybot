#!/usr/bin/env bash
# Progreso de la captura de cubos de perps, y salud de lo que corre en paralelo. SOLO LECTURA.
#
# Existe para que la comprobacion sea UN comando fijo en vez de una tirada de comandos que cada
# ejecucion compone un poco distinta. La diferencia no es estetica: los permisos de Claude Code se
# guardan por CADENA EXACTA, asi que dos pasadas que escriben `head -60` y `head -n 40` piden dos
# permisos distintos y una tarea programada acaba parandose de madrugada a esperar a nadie.
#
#   bash scripts/perps-progreso.sh
#
# No escribe nada, no toca configuracion y no reinicia nada. Puede correrse con el bot en marcha.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

HITO=${HITO:-2000}
FICHERO=data/perps-analytics.jsonl
API=${API:-http://127.0.0.1:8787}

echo "=== CAPTURA DE PERPS ==="
if [ ! -f "$FICHERO" ]; then
  echo "NO EXISTE $FICHERO — la captura no ha empezado o PERPS_ENABLED no esta en true."
  exit 0
fi

# El hito es sobre cubos PUNTUABLES, no sobre lineas del fichero: un cubo que el feed no vio entero
# no se puede puntuar. El smoke imprime los dos numeros en su cabecera.
npx tsx src/smoke/perpsReplay.ts 2>&1 | head -8

echo ""
echo "=== RITMO Y ETA (hito: $HITO cubos) ==="
node -e '
const fs = require("fs");
const hito = Number(process.env.HITO || 2000);
const lineas = fs.readFileSync("data/perps-analytics.jsonl", "utf8").trim().split("\n");
const cubos = [];
for (const l of lineas) {
  try { cubos.push(JSON.parse(l).sample); } catch { /* linea a medias: se salta */ }
}
if (cubos.length === 0) { console.log("sin cubos legibles"); process.exit(0); }
const inicio = Math.min(...cubos.map((c) => c.bucketStartMs));
const horas = (Date.now() - inicio) / 3600000;
const ritmo = cubos.length / Math.max(horas, 0.01);
const faltan = hito - cubos.length;
console.log(`${cubos.length} de ${hito} | ${horas.toFixed(1)} h capturando | ritmo real ${ritmo.toFixed(1)} cubos/h (teorico 24)`);
if (faltan <= 0) {
  console.log("HITO ALCANZADO.");
} else {
  const eta = new Date(Date.now() + (faltan / ritmo) * 3600000);
  console.log(`faltan ${faltan} -> ${(faltan / ritmo / 24).toFixed(1)} dias | ETA ${eta.toISOString()}`);
}
// Los HUECOS importan mas que el recuento: el replay salta los cubos no consecutivos, asi que
// perdidas dispersas impedirian formar posiciones largas aunque el total pareciera sano.
const porInstrumento = new Map();
for (const c of cubos) {
  if (!porInstrumento.has(c.symbol)) porInstrumento.set(c.symbol, new Set());
  porInstrumento.get(c.symbol).add(c.bucketStartMs);
}
const M = 5 * 60 * 1000;
for (const [symbol, set] of porInstrumento) {
  const a = [...set].sort((x, y) => x - y);
  let huecos = 0, racha = 1, mejor = 1;
  for (let i = 1; i < a.length; i++) {
    if (a[i] - a[i - 1] === M) { racha++; mejor = Math.max(mejor, racha); }
    else { huecos++; racha = 1; }
  }
  console.log(`  ${symbol}: ${a.length} cubos, ${huecos} huecos, racha consecutiva mas larga ${mejor} (${(mejor / 12).toFixed(1)} h)`);
}
'

echo ""
echo "=== SALUD ==="
curl -s -m 10 "$API/api/health" || echo "SIN RESPUESTA en $API — el bot puede estar caido."
echo ""
curl -s -m 10 "$API/api/status" 2>/dev/null | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  try {
    const j = JSON.parse(d);
    console.log("perpsSummary:", JSON.stringify(j.perpsSummary ?? null));
    console.log("favorito vivo:", j.settings?.favoriteStrategyEnabled, "| banda", j.settings?.favoriteMinAsk + "-" + j.settings?.favoriteMaxAsk, "| ventana", j.settings?.entryWindowSeconds, "| live", j.settings?.favoriteAllowLive);
    console.log("loopHealth:", JSON.stringify(j.loopHealth ?? null));
  } catch { console.log("no se pudo leer /api/status"); }
});
'

echo ""
echo "=== LA PRUEBA DEL FAVORITO NO DEBE VERSE AFECTADA ==="
# Se cuenta desde el ledger y no desde la API porque el ledger es la fuente de verdad del P&L y
# sobrevive a los reinicios. Ritmo normal medido: 3-4 entradas/h. Cero es la senal que importa.
node -e '
const fs = require("fs");
const lineas = fs.readFileSync("data/trades.jsonl", "utf8").trim().split("\n");
const t = [];
for (const l of lineas) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.type === "trade_attempt") t.push(e.trade?.createdAtMs ?? 0);
}
t.sort((a, b) => a - b);
const ahora = Date.now();
for (const h of [1, 6, 24]) {
  const n = t.filter((x) => x >= ahora - h * 3600000).length;
  console.log(`  ultimas ${String(h).padStart(2)} h: ${String(n).padStart(3)} entradas = ${(n / h).toFixed(1)}/h`);
}
console.log(`  ultima entrada hace ${((ahora - t[t.length - 1]) / 60000).toFixed(0)} min`);
const PRE = Date.parse("2026-09-11T05:25:47Z");
console.log(`  desde la pre-registracion: ${t.filter((x) => x >= PRE).length} (hito: 300)`);
'
