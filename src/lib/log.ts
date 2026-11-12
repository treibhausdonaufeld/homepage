/** Strukturierte Logs auf stdout (eine JSON-Zeile pro Eintrag). */
type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, msg: string, data?: Record<string, unknown>) {
  if (level === 'debug' && !process.env.DEBUG) return;
  const entry: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      entry[k] = v instanceof Error ? { name: v.name, message: v.message } : v;
    }
  }
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => write('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
};
