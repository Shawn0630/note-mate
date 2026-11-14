// Minimal ZIP writer — stored entries (no compression), no dependencies.
// Written for the project Markdown export: a folder of .md + assets that
// unzips in Obsidian / Finder / python zipfile / unzip. Filenames are
// UTF-8 (general-purpose flag bit 11). Duplicate paths are skipped
// (first wins) so a plot image that already exists under assets/ never
// appears twice.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time for "now" (2-second granularity). Zero is a legal value
// (1980-01-01) but a real timestamp is friendlier in a file manager.
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5)
    | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5)
    | (d.getDate() & 0x1f);
  return { time, date };
}

function validateName(name) {
  if (typeof name !== 'string' || !name) throw new Error('zip entry name is required');
  const parts = name.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`invalid zip entry name: ${name}`);
  }
  return name;
}

export function createZip() {
  const entries = []; // {name, data: Buffer, crc, time, date}
  const seen = new Set();
  return {
    addFile(name, data) {
      const clean = validateName(name);
      if (seen.has(clean)) return false; // duplicate path — first wins
      seen.add(clean);
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8');
      const { time, date } = dosDateTime();
      entries.push({ name: clean, data: buf, crc: crc32(buf), time, date });
      return true;
    },
    fileCount() {
      return entries.length;
    },
    toBuffer() {
      const localParts = [];
      const centralParts = [];
      let offset = 0;
      for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); // local file header
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
        local.writeUInt16LE(0, 8); // method: stored
        local.writeUInt16LE(e.time, 10);
        local.writeUInt16LE(e.date, 12);
        local.writeUInt32LE(e.crc, 14);
        local.writeUInt32LE(e.data.length, 18); // compressed size = stored
        local.writeUInt32LE(e.data.length, 22); // uncompressed size
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // extra length
        localParts.push(local, nameBuf, e.data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); // central file header
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(e.time, 12);
        central.writeUInt16LE(e.date, 14);
        central.writeUInt32LE(e.crc, 16);
        central.writeUInt32LE(e.data.length, 20);
        central.writeUInt32LE(e.data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(0, 38); // external attrs
        central.writeUInt32LE(offset, 42); // local header offset
        centralParts.push(central, nameBuf);
        offset += 30 + nameBuf.length + e.data.length;
      }
      const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); // end of central directory
      end.writeUInt16LE(0, 4); // disk
      end.writeUInt16LE(0, 6); // central disk
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(centralSize, 12);
      end.writeUInt32LE(offset, 16);
      end.writeUInt16LE(0, 20); // comment length
      return Buffer.concat([...localParts, ...centralParts, end]);
    },
  };
}

/**
 * Minimal ZIP reader for archives our own writer produces: stored entries
 * (method 0), no data descriptors, no encryption. Used by the data import
 * to validate an export archive BEFORE writing anything. Returns
 * [{name, data: Buffer, crc}] in central-directory order. Throws an Error
 * (status 400) on anything that is not such an archive.
 */
export function readZip(input) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  };
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (buf.length < 22) fail('not a zip archive');
  // End of central directory: signature 0x06054b50, comment up to 64KiB.
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) fail('not a zip archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buf.length) fail('zip central directory is truncated');
  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      fail('zip central directory is corrupt');
    }
    const method = buf.readUInt16LE(p + 10);
    const flags = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (method !== 0) fail(`unsupported zip entry method ${method} for ${name} (stored only)`);
    if (flags & 0x08) fail(`unsupported zip data descriptor for ${name}`);
    if (compSize !== uncompSize) fail(`zip entry size mismatch for ${name}`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      fail(`zip local header missing for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) fail(`zip entry truncated: ${name}`);
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (crc32(data) !== crc) fail(`zip entry checksum mismatch: ${name}`);
    // Same name rule as the writer: no empty / . / .. segments.
    const parts = name.split('/');
    if (!name || parts.some((seg) => seg === '' || seg === '.' || seg === '..')) {
      fail(`invalid zip entry name: ${name}`);
    }
    entries.push({ name, data: Buffer.from(data), crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
