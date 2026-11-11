import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText, MAX_PAGES } from '../src/pdftext.js';

/** Build a minimal valid 1-page PDF containing `text` (offsets computed). */
export function makeTinyPdf(text = 'Hello Deep Learning') {
  const objs = [];
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objs[2] = Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs[3] = Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  const stream = Buffer.from(`BT /F1 24 Tf 100 700 Td (${text}) Tj ET`);
  objs[4] = Buffer.concat([
    Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
    stream,
    Buffer.from('\nendstream'),
  ]);
  objs[5] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = chunks.reduce((a, c) => a + c.length, 0);
    chunks.push(Buffer.from(`${i} 0 obj\n`), objs[i], Buffer.from('\nendobj\n'));
  }
  const xrefAt = chunks.reduce((a, c) => a + c.length, 0);
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

test('extractPdfText: reads text from a tiny fixture PDF', async () => {
  assert.equal(MAX_PAGES, 40);
  const out = await extractPdfText(makeTinyPdf('Hello Deep Learning'));
  assert.equal(out.numPages, 1);
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].page, 1);
  assert.match(out.pages[0].text, /Hello Deep Learning/);
  assert.match(out.text, /--- page 1 ---/);
});

test('extractPdfText: non-PDF bytes are a 400', async () => {
  await assert.rejects(
    extractPdfText(Buffer.from('this is not a pdf at all')),
    (err) => err.status === 400 && /readable PDF/.test(err.message),
  );
});
