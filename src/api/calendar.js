import { Router } from 'express';
import { buildIcsContent } from '../utils/calendarLink.js';

export const calendarRouter = Router();

const ICS_FILENAME = 'programare.ics';

/**
 * @param {import('express').Request} req
 */
function parseEventQuery(req) {
  const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
  const start = typeof req.query.start === 'string' ? req.query.start.trim() : '';
  const end = typeof req.query.end === 'string' ? req.query.end.trim() : '';
  const details = typeof req.query.details === 'string' ? req.query.details : '';
  const location = typeof req.query.location === 'string' ? req.query.location : '';

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (!title || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { error: 'Invalid calendar event. Required query params: title, start, end (ISO).' };
  }
  if (endDate.getTime() <= startDate.getTime()) {
    return { error: 'end must be after start' };
  }

  return {
    title: title.slice(0, 200),
    startDate,
    endDate,
    details: details.slice(0, 1500),
    location: location.slice(0, 300),
  };
}

/**
 * Headers that force a file download (not inline BEGIN:VCALENDAR text).
 * @param {import('express').Response} res
 * @param {number} byteLength
 */
function setIcsDownloadHeaders(res, byteLength) {
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ICS_FILENAME}"; filename*=UTF-8''${ICS_FILENAME}`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Length', String(byteLength));
}

/**
 * Public .ics download — attachment, never inline text.
 * Query: title, start (ISO), end (ISO), details?, location?
 */
function sendIcsFile(req, res) {
  const parsed = parseEventQuery(req);
  if ('error' in parsed && parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const ics = buildIcsContent({
    title: parsed.title,
    startIso: parsed.startDate,
    endIso: parsed.endDate,
    description: parsed.details,
    location: parsed.location,
  });
  const body = Buffer.from(ics, 'utf8');

  setIcsDownloadHeaders(res, body.length);
  return res.status(200).end(body);
}

calendarRouter.head('/event.ics', (req, res) => {
  const parsed = parseEventQuery(req);
  if ('error' in parsed && parsed.error) {
    return res.status(400).end();
  }
  const ics = buildIcsContent({
    title: parsed.title,
    startIso: parsed.startDate,
    endIso: parsed.endDate,
    description: parsed.details,
    location: parsed.location,
  });
  setIcsDownloadHeaders(res, Buffer.byteLength(ics, 'utf8'));
  return res.status(200).end();
});

calendarRouter.get('/event.ics', sendIcsFile);
