export interface Clock {
  now(): Date;
  timeZone(): string;
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export const systemClock: Clock = {
  now: () => new Date(),
  timeZone: systemTimeZone,
};

function localDateTime(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

export function formatClockContext(clock: Clock): string {
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Clock returned an invalid date.');
  const timeZone = clock.timeZone();
  if (typeof timeZone !== 'string' || !timeZone.trim()) throw new Error('Clock returned an invalid timezone.');
  return `Current date/time: ${localDateTime(now, timeZone)}; timezone: ${timeZone}; UTC: ${now.toISOString()}.`;
}

export function withClockContext(instructions: string, clockContext: string): string {
  return instructions ? `${instructions}\n\n${clockContext}` : clockContext;
}
