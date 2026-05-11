type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  at: string;
  level: LogLevel;
  message: string;
  meta?: unknown;
}

type LogListener = (entry: LogEntry) => void;

const listeners = new Set<LogListener>();

function write(level: LogLevel, message: string, meta?: unknown): void {
  const entry: LogEntry = {
    at: new Date().toISOString(),
    level,
    message,
    meta,
  };
  const base = `[${entry.at}] ${level.toUpperCase()} ${message}`;
  if (meta === undefined) {
    console.log(base);
  } else {
    console.log(`${base} ${JSON.stringify(meta)}`);
  }

  for (const listener of listeners) {
    listener(entry);
  }
}

export const logger = {
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
  subscribe: (listener: LogListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
