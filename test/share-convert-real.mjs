/**
 * Diagnostic: convert a real share payload and report the result.
 *
 * Usage: node checks/share-convert-real.mjs <share-messages.json> <projectRoot>
 */
import { readFileSync } from 'node:fs';
import { convertShare, shareUrl } from '../lib/share.trae2.js';
import { firstStructuralViolation } from '../lib/vault.trae2.js';

const [, , file, cwd = process.cwd()] = process.argv;
const body = JSON.parse(readFileSync(file, 'utf8'));
const data = body.data ?? body;
const items = data.items ?? data;

const share = {
  shareId: 'H4TT51C..LW19X',
  origin: 'https://share.traecontent.cn',
  url: 'https://share.traecontent.cn/share/H4TT51C..LW19X',
  title: 'Fix ATS Secure Connection Error',
  createdAt: Date.parse('2026-10-09T13:10:18+08:00'),
  creatorName: 'tester',
  messages: items,
};
const conversion = convertShare(share, { cwd, maxToolResultChars: 2000 });
console.log('stats:', JSON.stringify(conversion.stats));
console.log('warnings:', JSON.stringify(conversion.warnings, null, 1));
console.log('header:', JSON.stringify(conversion.header));
console.log('sourceUrl:', shareUrl(share));
const violation = firstStructuralViolation(conversion.events, conversion.header.id);
console.log('structural violation:', violation ?? 'NONE');
console.log('event types:', [...new Set(conversion.events.map((e) => e.type))].join(', '));
console.log('conversation messages:', conversion.conversation.messages.length);
console.log('--- first 12 events ---');
for (const event of conversion.events.slice(0, 12)) {
  console.log(event.seq, event.type, JSON.stringify(event.data).slice(0, 150));
}
console.log('--- first assistant message with a tool call ---');
const first = conversion.events.find((e) => e.type === 'assistant/message' && e.data.message.content.some((b) => b.type === 'tool-call'));
console.log(JSON.stringify({ ...first, data: { ...first.data, stream: `[${first.data.stream.length}]` } }, null, 1).slice(0, 2500));
console.log('--- markdown head ---');
import { renderMarkdown } from '../lib/vault.trae2.js';
console.log(renderMarkdown(conversion.conversation).split('\n').slice(0, 22).join('\n'));
