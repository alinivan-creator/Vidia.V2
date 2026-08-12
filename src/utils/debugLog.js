import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_LOG = path.join(__dirname, '../../webhook-debug.log');

/**
 * Appends a line to webhook-debug.log (always visible even if terminal watch breaks).
 * @param {string} label
 * @param {unknown} [payload]
 */
export function debugLog(label, payload = null) {
  const line =
    `[${new Date().toISOString()}] ${label}` +
    (payload !== null ? ` ${typeof payload === 'string' ? payload : JSON.stringify(payload)}` : '') +
    '\n';

  try {
    fs.appendFileSync(DEBUG_LOG, line, 'utf8');
  } catch {
    // ignore disk errors
  }

  console.log(label, payload ?? '');
}
