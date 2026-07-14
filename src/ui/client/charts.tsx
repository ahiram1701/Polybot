import type { LabeledValue } from "./chartData.js";

/**
 * Dependency-free inline-SVG charts. Theming comes from the existing CSS variables (via `currentColor`
 * and explicit var() strokes), sizing is responsive (viewBox + width:100%), and hovers use the native
 * <title> tooltip. Kept intentionally dumb: all math lives in chartData.ts.
 */

const W = 100;
const H = 32;

export function Sparkline({
  values,
  format,
  title,
  baseline = 0,
}: {
  values: number[];
  format?: (value: number) => string;
  title?: string;
  // Draw a reference line at this value (e.g. 0 for P&L, break-even for win rate).
  baseline?: number;
}) {
  if (values.length < 2) {
    return <div className="chart-empty">sin datos suficientes</div>;
  }
  const min = Math.min(baseline, ...values);
  const max = Math.max(baseline, ...values);
  const range = max - min || 1;
  const x = (index: number) => (index / (values.length - 1)) * W;
  const y = (value: number) => H - ((value - min) / range) * H;
  const last = values[values.length - 1];
  const line = values.map((value, index) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const area = `0,${H} ${line} ${W},${H}`;
  const tone = last >= baseline ? "positive" : "negative";
  const baseY = y(baseline).toFixed(2);

  return (
    <svg className={`sparkline ${tone}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={title}>
      {title && <title>{title}</title>}
      <polygon className="sparkline-area" points={area} />
      <line className="sparkline-base" x1={0} y1={baseY} x2={W} y2={baseY} />
      <polyline className="sparkline-line" points={line} />
      <circle className="sparkline-dot" cx={x(values.length - 1)} cy={y(last)} r={1.6} />
    </svg>
  );
}

/**
 * Horizontal bars, diverging around zero (so negatives point left). Optional `reference` draws a tick
 * per bar (used for break-even / predicted probability). `formatValue` renders the trailing label.
 */
export function BarChart({
  data,
  formatValue,
  formatReference,
  domain,
}: {
  data: LabeledValue[];
  formatValue: (value: number) => string;
  formatReference?: (value: number) => string;
  // Force a symmetric/explicit domain; defaults to the data's own min/max.
  domain?: { min: number; max: number };
}) {
  if (data.length === 0) {
    return <div className="chart-empty">sin datos</div>;
  }
  const values = data.map((item) => item.value);
  const refs = data.flatMap((item) => (item.reference !== undefined ? [item.reference] : []));
  const min = Math.min(0, domain?.min ?? Math.min(...values, ...refs));
  const max = Math.max(0, domain?.max ?? Math.max(...values, ...refs));
  const span = max - min || 1;
  const zero = (-min / span) * 100;

  return (
    <div className="bar-chart">
      {data.map((item) => {
        const valuePct = (Math.abs(item.value) / span) * 100;
        const startPct = item.value >= 0 ? zero : zero - valuePct;
        const refPct = item.reference !== undefined ? ((item.reference - min) / span) * 100 : undefined;
        return (
          <div className="bar-row" key={item.label} title={`${item.label}: ${formatValue(item.value)}${item.count !== undefined ? ` (${item.count})` : ""}`}>
            <span className="bar-label">{item.label}</span>
            <div className="bar-track">
              <span className="bar-zero" style={{ left: `${zero}%` }} />
              <span
                className={`bar-fill ${item.value >= 0 ? "positive" : "negative"}`}
                style={{ left: `${startPct}%`, width: `${Math.max(valuePct, 0.5)}%` }}
              />
              {refPct !== undefined && (
                <span
                  className="bar-ref"
                  style={{ left: `${Math.min(Math.max(refPct, 0), 100)}%` }}
                  title={formatReference ? formatReference(item.reference!) : String(item.reference)}
                />
              )}
            </div>
            <span className="bar-value">{formatValue(item.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Calibration: predicted probability (the bar's reference tick / ideal) vs the REAL win rate (the fill).
 * A fill shorter than the tick = overconfidence in that bucket.
 */
export function CalibrationChart({ buckets }: { buckets: LabeledValue[] }) {
  if (buckets.length === 0) {
    return <div className="chart-empty">sin predicciones registradas</div>;
  }
  return (
    <div className="bar-chart calibration">
      {buckets.map((bucket) => {
        const realPct = bucket.value * 100;
        const predPct = (bucket.reference ?? 0) * 100;
        const overconfident = (bucket.reference ?? 0) - bucket.value > 0.08;
        return (
          <div
            className="bar-row"
            key={bucket.label}
            title={`Predicho ${predPct.toFixed(0)}% → real ${realPct.toFixed(0)}% (${bucket.count} trades)`}
          >
            <span className="bar-label">{bucket.label}</span>
            <div className="bar-track">
              <span className={`bar-fill ${overconfident ? "negative" : "positive"}`} style={{ left: "0%", width: `${realPct}%` }} />
              <span className="bar-ref" style={{ left: `${predPct}%` }} title={`predicho ${predPct.toFixed(0)}%`} />
            </div>
            <span className="bar-value">{realPct.toFixed(0)}%</span>
          </div>
        );
      })}
    </div>
  );
}
