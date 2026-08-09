/**
 * Structured logging facade. The server binds this to a JSON-line logger;
 * tests and the client can use the console implementation. Gameplay code
 * depends only on this interface.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, string | number | boolean | null | undefined>

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Child logger with fields bound to every entry (e.g. system name). */
  child(fields: LogFields): Logger
}

export function createConsoleLogger(base: LogFields = {}, minLevel: LogLevel = 'info'): Logger {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (order[level] < order[minLevel]) return
    const entry = { level, msg, ts: new Date().toISOString(), ...base, ...fields }
    const line = JSON.stringify(entry)
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createConsoleLogger({ ...base, ...fields }, minLevel),
  }
}

export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
}
