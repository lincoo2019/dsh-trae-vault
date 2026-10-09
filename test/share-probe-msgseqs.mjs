/**
 * Diagnostic: find where convertShare computes the title's messageSeqs.
 *
 * Reads the module source, instruments the emit helper and the userSeq
 * assignment to append to a log file, writes the instrumented copy to a temp
 * path, imports it, and reports the recorded order. The real module is never
 * modified.
 *
 * Usage: node checks/share-probe-msgseqs.mjs
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = join(import.meta.dirname, '..', 'lib', 'share.trae2.js');
const dir = mkdtempSync(join(tmpdir(), 'share-probe-'));
const copy = join(dir, 'share.probe.mjs');
const log = join(dir, 'order.log');

let text = readFileSync(source, 'utf8');
const emitMarker = '  const emit = (type, time, data, extra) => {';
const userMarker = '      const userSeq = events.length;';
if (!text.includes(emitMarker)) throw new Error('emit marker not found');
if (!text.includes(userMarker)) throw new Error('userSeq marker not found');
text = text.replace(emitMarker, `${emitMarker} globalThis.__probe?.('EMIT', type, events.length);`);
text = text.replace(userMarker, `${userMarker} globalThis.__probe?.('USERSEQ', events.length);`);
// The lib modules are imported relatively; point them at the real directory.
text = text.replace(/from '\.\/vault\.trae2\.js'/g, `from ${JSON.stringify(pathToFileURL(source).href.replace(/share\.trae2\.js$/, 'vault.trae2.js').replace(/\\/g, '/'))}`);
writeFileSync(copy, text);

globalThis.__probe = (label, ...values) => appendFileSync(log, `${label}\t${values.join('\t')}\n`);

const { convertShare } = await import(pathToFileURL(copy).href);
const items = [
  { role: 'user', created_at: '2026-01-02T03:00:00+08:00', content: JSON.stringify([{ type: 'text', text_content: 'first' }]) },
];
const conversion = convertShare({ shareId: 'X..Y', title: 'T', messages: items }, { cwd: 'E:\\x' });
appendFileSync(log, `RESULT\t${JSON.stringify(conversion.events.find((event) => event.type === 'session/title')?.data)}\n`);

console.log(readFileSync(log, 'utf8').trimEnd());
console.log('\ntemp dir:', dir);
rmSync(dir, { recursive: true, force: true });
