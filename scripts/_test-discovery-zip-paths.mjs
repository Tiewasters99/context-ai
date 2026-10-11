// Production ZIPs made on Windows: entry names with backslash separators.
//
//   node scripts/_test-discovery-zip-paths.mjs
//
// Offline. Found 2026-10-11: a production zipped with PowerShell 5.1's
// Compress-Archive (entries like `patel\PL-000001.docx`) failed the whole
// intake with "Malicious entry", because node-stream-zip rejects any
// backslash. The worker now opens ZIPs with skipEntryNameValidation and runs
// every name through zipEntryPath, which normalises the separator and keeps
// the traversal rules.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import StreamZip from 'node-stream-zip';
import { zipEntryPath } from '../lib/discovery/util.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  PASS  ${m}`); };

// The rule itself.
assert.equal(zipEntryPath('patel\\PL-000001.docx'), 'patel/PL-000001.docx');
assert.equal(zipEntryPath('vol1/patel/PL-000002.txt'), 'vol1/patel/PL-000002.txt');
assert.equal(zipEntryPath('a\\b\\c..d.pdf'), 'a/b/c..d.pdf');
ok('backslash separators become forward slashes; ordinary names unchanged');
for (const bad of ['..\\outside.docx', 'patel\\..\\..\\x', '../x', 'C:\\Windows\\x.dll', 'C:x', '\\abs.txt', '/abs.txt']) {
  assert.throws(() => zipEntryPath(bad), /Malicious entry/, bad);
}
ok('traversal, drive letters and absolute paths are still refused (either separator)');

// End to end through node-stream-zip, as intakeZip opens the archive.
const zipFile = new JSZip();
zipFile.file('patel\\PL-000001.docx', 'one');
zipFile.file('investigator\\PL-000151.txt', 'two');
const tmp = path.join(os.tmpdir(), `zip-paths-${process.pid}.zip`);
await fs.writeFile(tmp, await zipFile.generateAsync({ type: 'nodebuffer' }));
try {
  const strict = new StreamZip.async({ file: tmp });
  await assert.rejects(strict.entries(), /Malicious entry/);
  await strict.close().catch(() => {});
  ok('the default node-stream-zip check rejects a Windows-made archive (the bug)');

  const zip = new StreamZip.async({ file: tmp, skipEntryNameValidation: true });
  const entries = Object.values(await zip.entries())
    .map((e) => ({ raw: e.name, name: zipEntryPath(e.name), isDirectory: e.isDirectory }))
    .filter((e) => !e.isDirectory);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['investigator/PL-000151.txt', 'patel/PL-000001.docx']);
  assert.equal(path.posix.basename(entries.find((e) => e.name.startsWith('patel/')).name), 'PL-000001.docx');
  assert.equal(String(await zip.entryData(entries.find((e) => e.name.startsWith('patel/')).raw)), 'one');
  await zip.close();
  ok('with the worker\'s settings both entries are read, named by folder and file');
} finally {
  await fs.unlink(tmp).catch(() => {});
}

console.log(`\nALL ${n} CHECKS PASSED`);
