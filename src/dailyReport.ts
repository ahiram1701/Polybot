import { dayKeyInTimeZone, hourInTimeZone } from "./timezone.js";

/**
 * Daily Telegram self-report: one message at the configured hour with everything the user would
 * otherwise open the dashboard to check. Pure helpers (decision + formatting) so the controller stays
 * a thin gatherer and the logic is unit-testable.
 */

export interface DailyReportSchedule {
  nowMs: number;
  hour: number;
  timeZone?: string;
  lastSentDayKey?: string;
}

export function shouldSendDailyReport(schedule: DailyReportSchedule): { send: boolean; dayKey: string } {
  const dayKey = dayKeyInTimeZone(schedule.nowMs, schedule.timeZone);
  const currentHour = hourInTimeZone(schedule.nowMs, schedule.timeZone);
  return {
    send: currentHour >= schedule.hour && dayKey !== schedule.lastSentDayKey,
    dayKey,
  };
}

export interface DailyReportData {
  dayKey: string;
  mode?: string;
  running: boolean;
  todayNetUsd: number;
  todayTrades: number;
  todayWins: number;
  postResetNetUsd: number;
  postResetTrades: number;
  validationTarget: number;
  varianceBandUsd: number;
  withinBand: boolean;
  riskHalt?: { tripped: boolean; reason?: string };
  autoAdjust: { market: string; state: string }[];
  capTuner: { market: string; current: number; target?: number }[];
  memoryRssMb: number;
}

export function formatDailyReport(data: DailyReportData): { title: string; body: string } {
  const winRate = data.todayTrades > 0 ? ` (${data.todayWins}W/${data.todayTrades - data.todayWins}L)` : "";
  const lines = [
    `Hoy: ${signedUsd(data.todayNetUsd)} en ${data.todayTrades} trades${winRate}.`,
    `Post-reset: ${signedUsd(data.postResetNetUsd)} · ${Math.min(data.postResetTrades, data.validationTarget)}/${data.validationTarget} trades del plan · ` +
      (data.withinBand
        ? `dentro de la banda de varianza (±$${data.varianceBandUsd.toFixed(0)}) — aún ruido.`
        : `FUERA de la banda (±$${data.varianceBandUsd.toFixed(0)}) — ya es señal.`),
    `Bot: ${data.running ? `corriendo ${data.mode ?? ""}`.trim() : "detenido"}${data.riskHalt?.tripped ? ` · FRENO activo (${data.riskHalt.reason ?? "?"})` : ""}.`,
  ];
  if (data.autoAdjust.length > 0) {
    lines.push(`Autoajuste: ${data.autoAdjust.map((entry) => `${entry.market} ${entry.state}`).join(" · ")}.`);
  }
  const capsWithTarget = data.capTuner.filter((entry) => entry.target !== undefined && Math.abs(entry.target - entry.current) >= 0.005);
  if (capsWithTarget.length > 0) {
    lines.push(
      `Cap sugerido: ${capsWithTarget.map((entry) => `${entry.market} ${entry.current.toFixed(2)}->${entry.target!.toFixed(2)}`).join(" · ")}.`,
    );
  }
  lines.push(`Salud: RSS ${data.memoryRssMb}MB.`);
  return { title: `Reporte diario Polybot (${data.dayKey})`, body: lines.join("\n") };
}

function signedUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}
