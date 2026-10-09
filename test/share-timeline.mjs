/**
 * Diagnostic: confirm the shared conversation's turns are in order and each has
 * its own timestamp.
 *
 * Usage: node checks/share-timeline.mjs <share-messages.json> <projectRoot>
 */
import { readFileSync } from 'node:fs';
import { convertShare } from '../lib/share.trae2.js';

const [, , file, cwd = process.cwd()] = process.argv;
const body = JSON.parse(readFileSync(file, 'utf8'));
const items = body.data?.items ?? body.items ?? [];
const conversion = convertShare({
  shareId: 'H4TT51C..LW19X',
  origin: 'https://share.traecontent.cn',
  title: 'Fix ATS Secure Connection Error',
  messages: items,
}, { cwd });

const turns = new Map();
for (const event of conversion.events) {
  const turn = event.data?.turn;
  if (!Number.isInteger(turn)) continue;
  const entry = turns.get(turn) ?? { first: event.time, last: event.time, types: new Set() };
  entry.first = Math.min(entry.first, event.time);
  entry.last = Math.max(entry.last, event.time);
  entry.types.add(event.type);
  turns.set(turn, entry);
}
let previous = 0;
let ordered = true;
for (const [turn, entry] of [...turns].sort((a, b) => a[0] - b[0])) {
  const iso = new Date(entry.first).toISOString();
  console.log(`turn ${String(turn).padStart(2)}  ${iso}  span=${entry.last - entry.first}ms`);
  if (entry.first < previous) ordered = false;
  previous = entry.first;
}
const times = conversion.events.map((event) => event.time);
console.log('strictly non-decreasing times:', times.every((time, index) => index === 0 || time >= times[index - 1]));
console.log('turns in order:', ordered);
console.log('distinct event times:', new Set(times).size, 'of', times.length);
