import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfOutline } from '../src/pdfOutline.js';
import { makeMultiPagePdf } from './pdftext.test.js';

/**
 * Build a minimal valid 3-page PDF whose outline is:
 *   Introduction -> p.1
 *   Methods      -> p.2
 *     Method details -> p.3 (child of Methods)
 * Page i contains `Page i text`.
 */
export function makePdfWithOutline() {
  const objs = {};
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R /Outlines 10 0 R >>');
  objs[2] = Buffer.from('<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>');
  const fontObj = 9;
  for (let i = 1; i <= 3; i++) {
    const pageObj = 3 + 2 * (i - 1);
    const contentsObj = 4 + 2 * (i - 1);
    objs[pageObj] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentsObj} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`);
    const stream = Buffer.from(`BT /F1 24 Tf 100 700 Td (Page ${i} text) Tj ET`);
    objs[contentsObj] = Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from('\nendstream'),
    ]);
  }
  objs[fontObj] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objs[10] = Buffer.from('<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 3 >>');
  objs[11] = Buffer.from('<< /Title (Introduction) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /XYZ 0 792 null] >>');
  objs[12] = Buffer.from('<< /Title (Methods) /Parent 10 0 R /Prev 11 0 R /First 13 0 R /Last 13 0 R /Count 1 /Dest [5 0 R /XYZ 0 792 null] >>');
  objs[13] = Buffer.from('<< /Title (Method details) /Parent 12 0 R /Dest [7 0 R /XYZ 0 792 null] >>');

  const total = 13;
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (let i = 1; i <= total; i++) {
    offsets[i] = chunks.reduce((a, c) => a + c.length, 0);
    chunks.push(Buffer.from(`${i} 0 obj\n`), objs[i], Buffer.from('\nendobj\n'));
  }
  const xrefAt = chunks.reduce((a, c) => a + c.length, 0);
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

test('extractPdfOutline: flattened items with pages and depths', async () => {
  const out = await extractPdfOutline(makePdfWithOutline());
  assert.deepEqual(out, [
    { title: 'Introduction', page: 1, depth: 0 },
    { title: 'Methods', page: 2, depth: 0 },
    { title: 'Method details', page: 3, depth: 1 },
  ]);
});

test('extractPdfOutline: PDF without an outline returns []', async () => {
  assert.deepEqual(await extractPdfOutline(makeMultiPagePdf(3)), []);
});

test('extractPdfOutline: non-PDF bytes are a 400', async () => {
  await assert.rejects(
    extractPdfOutline(Buffer.from('this is not a pdf at all')),
    (err) => err.status === 400 && /readable PDF/.test(err.message),
  );
});
