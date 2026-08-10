import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**"],
    /**
     * 20s en vez de los 5s por defecto.
     *
     * Buena parte de esta bateria toca disco de verdad: escrituras atomicas, ficheros de analitica,
     * almacenes de estado. Con los workers en paralelo sobre Windows, esos 5s se agotaban de vez en
     * cuando —~1 de cada 10 corridas— en `atomicWrite` y `analyticsRecorder`, siempre bajo carga y
     * nunca al reintentar en solitario. El test no estaba mal: el plazo estaba pensado para pruebas
     * puras de CPU.
     *
     * NO esconde cuelgues: uno de verdad sigue fallando, solo que 15s mas tarde. Si vuelve a saltar un
     * timeout aqui, la causa es real y no el reloj.
     */
    testTimeout: 20_000,
  },
});
