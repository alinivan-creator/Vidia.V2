import { supabase } from '../config/supabase.js';
import { classifyDbError } from './schemaErrors.js';

const ALERT_DEDUPE_MS = 10 * 60 * 1000;
/** @type {Map<string, number>} */
const alertDedupe = new Map();

/**
 * @typedef {'debug' | 'info' | 'warning' | 'error' | 'critical'} ErrorSeverity
 * @typedef {'meta_api' | 'google_calendar' | 'ai' | 'webhook' | 'system' | 'database'} ErrorSource
 */

/**
 * @typedef {Object} LogErrorInput
 * @property {string} message
 * @property {ErrorSource} source
 * @property {ErrorSeverity} [severity]
 * @property {string | null} [businessId]
 * @property {Record<string, unknown>} [details]
 * @property {string | null} [requestId]
 * @property {string | null} [phoneNumber]
 * @property {string | null} [draftBookingId]
 * @property {number | null} [httpStatus]
 * @property {Error | unknown} [error]
 */

/**
 * Serializes an Error (or unknown value) into a JSON-safe details object.
 * @param {Error | unknown} error
 * @returns {Record<string, unknown>}
 */
function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { raw: error };
}

/**
 * Persists a structured error row to `error_logs`.
 * Never throws — failures fall back to stderr so webhook handlers stay alive.
 *
 * @param {LogErrorInput} input
 * @returns {Promise<string | null>} Inserted log ID, or null on failure
 */
export async function logError({
  message,
  source,
  severity = 'error',
  businessId = null,
  details = {},
  requestId = null,
  phoneNumber = null,
  draftBookingId = null,
  httpStatus = null,
  error = null,
}) {
  const classified = classifyDbError(error, {
    table: typeof details.table === 'string' ? details.table : undefined,
  });
  const finalMessage = classified && !String(message).startsWith('Eroare:')
    ? classified.adminMessage
    : message;

  const mergedDetails = {
    ...details,
    ...(classified
      ? {
          alert: true,
          alertKind: classified.kind,
          table: classified.table,
          hint: classified.hint,
        }
      : {}),
    ...(error ? { error: serializeError(error) } : {}),
  };

  if (classified) {
    const key = `${classified.kind}:${classified.table || 'unknown'}`;
    const prev = alertDedupe.get(key) ?? 0;
    if (Date.now() - prev < ALERT_DEDUPE_MS) {
      console.error(`[loggerService] ${finalMessage}`);
      return null;
    }
    alertDedupe.set(key, Date.now());
  }

  try {
    const { data, error: dbError } = await supabase
      .from('error_logs')
      .insert({
        business_id: businessId,
        severity,
        source,
        message: finalMessage,
        details: mergedDetails,
        request_id: requestId,
        phone_number: phoneNumber,
        draft_booking_id: draftBookingId,
        http_status: httpStatus,
      })
      .select('id')
      .single();

    if (dbError) {
      console.error('[loggerService] Failed to write error_logs:', dbError.message, {
        originalMessage: message,
        source,
      });
      return null;
    }

    return data?.id ?? null;
  } catch (unexpected) {
    console.error('[loggerService] Unexpected failure:', unexpected);
    return null;
  }
}

/**
 * Registers global handlers for uncaught errors.
 * Persists to error_logs before exit so crashes are visible in the admin dashboard.
 */
export function registerProcessErrorHandlers() {
  /**
   * @param {'uncaughtException' | 'unhandledRejection'} type
   * @param {unknown} error
   */
  function logFatalAndExit(type, error) {
    console.error(`[vidia-v2][fatal] ${type}:`, error);

    const writeLog = logError({
      message: `Process ${type}`,
      source: 'system',
      severity: 'critical',
      error,
      details: {
        type,
        pid: process.pid,
        nodeVersion: process.version,
      },
    });

    // Serverless: log only — process.exit() kills the Vercel isolate.
    if (process.env.VERCEL) {
      void writeLog;
      return;
    }

    // Allow up to 3s for Supabase write before exit
    Promise.race([writeLog, new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => {
      process.exit(1);
    });
  }

  process.on('uncaughtException', (error) => {
    logFatalAndExit('uncaughtException', error);
  });

  process.on('unhandledRejection', (reason) => {
    logFatalAndExit('unhandledRejection', reason);
  });
}
