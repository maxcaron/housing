// Structured logging: every line is one JSON object appended to logs/<date>.jsonl,
// mirrored to the console in readable form. Nothing is swallowed: use fatal() for
// conditions that must abort, and always attach enough context to act on the error
// without re-running (url, http status, response snippet, check name).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG_DIR = path.join(ROOT, 'logs');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const CONSOLE_MIN = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

let runId = null;
let stream = null;

export function logInit(prefix) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  runId = `${prefix}-${ts}`;
  stream = fs.createWriteStream(path.join(LOG_DIR, `${runId}.jsonl`), { flags: 'a' });
  return runId;
}

function emit(level, event, fields) {
  const rec = { ts: new Date().toISOString(), level, event, run: runId, ...fields };
  if (stream) stream.write(JSON.stringify(rec) + '\n');
  if (LEVELS[level] >= CONSOLE_MIN) {
    const extra = Object.entries(fields || {})
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    const line = `[${rec.ts}] ${level.toUpperCase().padEnd(5)} ${event}${extra ? ' ' + extra : ''}`;
    (LEVELS[level] >= LEVELS.warn ? console.error : console.log)(line);
  }
}

export const log = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
  fatal: (event, fields) => emit('fatal', event, fields),
};

// An assumption about Centris's behavior that no longer holds (endpoint renamed,
// payload shape changed, HTML structure changed, ...). `check` is a stable name
// for grepping logs; `context` is whatever makes the failure diagnosable.
export class ContractError extends Error {
  constructor(check, message, context = {}) {
    super(`[${check}] ${message}`);
    this.name = 'ContractError';
    this.check = check;
    this.context = context;
  }
}
