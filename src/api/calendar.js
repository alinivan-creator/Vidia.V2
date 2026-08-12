import { Router } from 'express';
import { buildIcsContent } from '../utils/calendarLink.js';

export const calendarRouter = Router();

/**
 * Public .ics download — opens Apple Calendar / prompts “Add event” on most phones.
 * Query: title, start (ISO), end (ISO), details?, location?
 */
calendarRouter.get('/event.ics', (req, res) => {
  const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
  const start = typeof req.query.start === 'string' ? req.query.start.trim() : '';
  const end = typeof req.query.end === 'string' ? req.query.end.trim() : '';
  const details = typeof req.query.details === 'string' ? req.query.details : '';
  const location = typeof req.query.location === 'string' ? req.query.location : '';

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (!title || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return res.status(400).json({
      error: 'Invalid calendar event. Required query params: title, start, end (ISO).',
    });
  }

  if (endDate.getTime() <= startDate.getTime()) {
    return res.status(400).json({ error: 'end must be after start' });
  }

  // Cap payload size — WhatsApp / URL length safety
  const safeTitle = title.slice(0, 200);
  const safeDetails = details.slice(0, 1500);
  const safeLocation = location.slice(0, 300);

  const ics = buildIcsContent({
    title: safeTitle,
    startIso: startDate,
    endIso: endDate,
    description: safeDetails,
    location: safeLocation,
  });

  const filename = 'vidia-programare.ics';
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).send(ics);
});
