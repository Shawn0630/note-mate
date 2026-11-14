import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { createZip, crc32 } from '../src/zipStore.js';

// Parse the central directory of a ZIP buffer → [{name, crc, size, offset}].
function parseCentral(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD signature');
  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      crc: buf.readUInt32LE(p + 16),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Read a stored entry's bytes from its local header.
function readLocalEntry(buf, offset) {
  assert.equal(buf.readUInt32LE(offset), 0x04034b50, 'local header signature');
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const size = buf.readUInt32LE(offset + 22);
  const start = offset + 30 + nameLen + extraLen;
  return buf.subarray(start, start + size);
}

test('crc32: matches node zlib on ASCII and binary input', () => {
  assert.equal(crc32(Buffer.from('hello')), zlibCrc32(Buffer.from('hello')));
  assert.equal(crc32(Buffer.from([0, 1, 2, 255, 128, 64])), zlibCrc32(Buffer.from([0, 1, 2, 255, 128, 64])));
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('createZip: stored entries round-trip with names, sizes, CRCs', () => {
  const zip = createZip();
  assert.equal(zip.addFile('proj/notes.md', '# Title\n\n## Intro\n'), true);
  assert.equal(zip.addFile('proj/assets/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])), true);
  assert.equal(zip.addFile('proj/ünïcode.md', 'héllo'), true);
  // Duplicate path: first wins, count unchanged.
  assert.equal(zip.addFile('proj/notes.md', 'other'), false);
  assert.equal(zip.fileCount(), 3);
  const buf = zip.toBuffer();
  const entries = parseCentral(buf);
  assert.deepEqual(entries.map((e) => e.name), ['proj/notes.md', 'proj/assets/pic.png', 'proj/ünïcode.md']);
  assert.equal(entries[0].crc, zlibCrc32(Buffer.from('# Title\n\n## Intro\n')));
  assert.equal(entries[0].size, Buffer.byteLength('# Title\n\n## Intro\n'));
  assert.equal(readLocalEntry(buf, entries[0].offset).toString('utf8'), '# Title\n\n## Intro\n');
  assert.deepEqual(readLocalEntry(buf, entries[1].offset), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(readLocalEntry(buf, entries[2].offset).toString('utf8'), 'héllo');
});

test('createZip: rejects traversal and empty names', () => {
  const zip = createZip();
  assert.throws(() => zip.addFile('../escape.md', 'x'), /invalid zip entry name/);
  assert.throws(() => zip.addFile('a//b.md', 'x'), /invalid zip entry name/);
  assert.throws(() => zip.addFile('', 'x'), /required/);
});

test('createZip: empty zip is a valid EOCD-only archive', () => {
  const buf = createZip().toBuffer();
  assert.equal(buf.length, 22);
  assert.deepEqual(parseCentral(buf), []);
});
