import { calculateTradePnl, estimateTradeFeeUsd, isWinningTrade } from "./pnl.js";
import { dayKeyInTimeZone } from "./timezone.js";
import type { MarketSymbol, Outcome, TradeAttempt } from "./types.js";

/**
 * Fiscal reporting: organizes RESOLVED LIVE trades (the only fiscally relevant ones — sim is always
 * excluded) into rows/summaries/CSV for the user's tax declaration. Every USD figure comes from the same
 * calculateTradePnl used by the dashboard, so the export reconciles exactly with what the UI shows. This
 * module records and organizes; it deliberately computes no taxes and applies no jurisdiction rules.
 */

export interface FiscalRow {
  id: string;
  resolvedAtMs: number;
  // Local-date ISO (YYYY-MM-DD): fiscal periods follow the user's local calendar day.
  fechaIso: string;
  mercado: MarketSymbol | undefined;
  lado: Outcome;
  won: boolean;
  invertidoUsd: number;
  comisionUsd: number;
  recibidoUsd: number;
  gananciaUsd: number;
  tipoCambioUsdMxn?: number;
  gananciaMxn?: number;
}

export interface FiscalMonthSummary {
  month: number; // 1-12
  operaciones: number;
  ganadas: number;
  perdidas: number;
  invertidoUsd: number;
  comisionesUsd: number;
  gananciaUsd: number;
  gananciaMxn?: number; // present only when EVERY row of the month has a rate (never a partial sum)
  operacionesConTasa: number;
}

export interface FiscalYearSummary {
  year: number;
  operaciones: number;
  ganadas: number;
  perdidas: number;
  invertidoUsd: number;
  comisionesUsd: number;
  gananciaUsd: number;
  gananciaMxn?: number;
  operacionesConTasa: number;
  months: FiscalMonthSummary[];
  availableYears: number[];
}

export type FxRateResolver = (fechaIso: string) => number | undefined;

export function buildFiscalRows(trades: TradeAttempt[], resolveRate?: FxRateResolver, timeZone?: string): FiscalRow[] {
  const rows: FiscalRow[] = [];
  for (const trade of trades) {
    if (trade.mode !== "live" || !trade.resolved) {
      continue;
    }
    const pnl = calculateTradePnl(trade);
    if (pnl.status !== "resolved") {
      continue;
    }
    const resolvedAtMs = trade.resolved.resolvedAtMs;
    const fechaIso = toLocalDateIso(resolvedAtMs, timeZone);
    const gananciaUsd = pnl.netUsd ?? 0;
    const tipoCambio = resolveRate?.(fechaIso);
    rows.push({
      id: trade.id,
      resolvedAtMs,
      fechaIso,
      mercado: trade.asset,
      lado: trade.outcome,
      won: isWinningTrade(trade),
      invertidoUsd: pnl.stakeUsd,
      comisionUsd: estimateTradeFeeUsd(trade),
      recibidoUsd: pnl.payoutUsd ?? 0,
      gananciaUsd,
      tipoCambioUsdMxn: tipoCambio,
      gananciaMxn: tipoCambio !== undefined ? gananciaUsd * tipoCambio : undefined,
    });
  }
  return rows.sort((left, right) => left.resolvedAtMs - right.resolvedAtMs);
}

export function summarizeFiscalYear(rows: FiscalRow[], year: number): FiscalYearSummary {
  const yearRows = rows.filter((row) => getYear(row.fechaIso) === year);
  const months: FiscalMonthSummary[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const monthRows = yearRows.filter((row) => getMonth(row.fechaIso) === month);
    if (monthRows.length === 0) {
      continue;
    }
    months.push({ month, ...summarizeRows(monthRows) });
  }
  return {
    year,
    ...summarizeRows(yearRows),
    months,
    availableYears: [...new Set(rows.map((row) => getYear(row.fechaIso)))].sort(),
  };
}

function summarizeRows(rows: FiscalRow[]): Omit<FiscalMonthSummary, "month"> {
  const withRate = rows.filter((row) => row.gananciaMxn !== undefined);
  return {
    operaciones: rows.length,
    ganadas: rows.filter((row) => row.won).length,
    perdidas: rows.filter((row) => !row.won).length,
    invertidoUsd: sum(rows.map((row) => row.invertidoUsd)),
    comisionesUsd: sum(rows.map((row) => row.comisionUsd)),
    gananciaUsd: sum(rows.map((row) => row.gananciaUsd)),
    // A partial MXN sum would silently understate the period, so only report it when complete.
    gananciaMxn: rows.length > 0 && withRate.length === rows.length ? sum(withRate.map((row) => row.gananciaMxn ?? 0)) : undefined,
    operacionesConTasa: withRate.length,
  };
}

const CSV_HEADER =
  "fecha,id,mercado,lado,resultado,invertido_usd,comision_usd,recibido_usd,ganancia_usd,tipo_cambio_usd_mxn,ganancia_mxn";

export function serializeFiscalCsv(rows: FiscalRow[]): string {
  const lines = rows.map((row) =>
    [
      row.fechaIso,
      row.id,
      row.mercado ?? "",
      row.lado,
      row.won ? "ganada" : "perdida",
      usd(row.invertidoUsd),
      usd(row.comisionUsd),
      usd(row.recibidoUsd),
      usd(row.gananciaUsd),
      row.tipoCambioUsdMxn !== undefined ? row.tipoCambioUsdMxn.toFixed(4) : "",
      row.gananciaMxn !== undefined ? row.gananciaMxn.toFixed(2) : "",
    ].join(","),
  );
  // BOM so Excel opens it as UTF-8 without mangling accents.
  return `﻿${[CSV_HEADER, ...lines].join("\r\n")}\r\n`;
}

export function fiscalCsvFilename(year: number, nowMs = Date.now(), timeZone?: string): string {
  return `polybot-fiscal-${year}-generado-${toLocalDateIso(nowMs, timeZone)}.csv`;
}

// Fiscal periods follow the user's configured calendar day ("auto" = system timezone).
function toLocalDateIso(timestampMs: number, timeZone?: string): string {
  return dayKeyInTimeZone(timestampMs, timeZone);
}

function getYear(fechaIso: string): number {
  return Number(fechaIso.slice(0, 4));
}

function getMonth(fechaIso: string): number {
  return Number(fechaIso.slice(5, 7));
}

function usd(value: number): string {
  return value.toFixed(2);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
