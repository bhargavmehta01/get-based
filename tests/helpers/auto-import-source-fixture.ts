import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A real, text-based PDF, deliberately containing no patient information. */
export function syntheticLabPdf(month = '01'): Buffer {
  const lines = ['SYNTHETIC TEST DATA - NOT A REAL PATIENT', 'Synthetic Laboratory - Blood report',
    `Collection date: 2026-${month}-12`, 'Specimen: serum. Fasting status: unknown.',
    'Glucose 5.2 mmol/l Reference range 3.9 - 5.6', 'Ferritin 65 ng/ml Reference range 20 - 200'];
  const stream = 'BT /F1 12 Tf 40 740 Td 20 TL\n' + lines.map(line => `(${line}) Tj T*`).join('\n') + '\nET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

/** No Paperless, AI model, API credentials, or external network required. */
export async function startAutoImportSourceFixture(options: { port?: number; allowedOrigins: string[]; beforeExtraction?: () => Promise<void> }) {
  const requests = { feeds: 0, pdfs: 0, ai: 0, extraction: 0 };
  let retryAttempts = 0;
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !options.allowedOrigins.includes(origin)) { res.writeHead(403).end(); return; }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const url = new URL(req.url || '/', 'http://fixture.invalid');
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)); };
    if (req.method === 'GET' && url.pathname === '/feed.json') {
      requests.feeds++;
      const scenario = url.searchParams.get('scenario') || 'single';
      const report = (id: string, month: string) => ({ id, title: `SYNTHETIC-${month}`, url: `/reports/${id}.pdf`, created: `2026-${month}-12T09:00:00Z` });
      const items = scenario === 'empty' ? [] : [report(scenario === 'retry' ? 'retry' : scenario === 'invalid' ? 'invalid' : 'january', '01')];
      if (scenario === 'two') items.push(report('february', '02'));
      json({ items }); return;
    }
    if (req.method === 'GET' && /^\/reports\/(january|february|retry|invalid)\.pdf$/.test(url.pathname)) {
      requests.pdfs++;
      if (url.pathname.includes('retry') && retryAttempts++ === 0) { json({ error: 'Synthetic temporary outage' }, 503); return; }
      const bytes = url.pathname.includes('invalid') ? Buffer.from('This is deliberately not a PDF.') : syntheticLabPdf(url.pathname.includes('february') ? '02' : '01');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length }).end(bytes); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') { json({ data: [{ id: 'synthetic-lab-fixture', name: 'Synthetic lab fixture (no inference)' }] }); return; }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      // Reject arbitrary documents. This endpoint is a deterministic fixture,
      // not an AI service. Do not log or persist incoming prompts.
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 256 * 1024) { json({ error: 'Fixture request too large' }, 413); return; }
      }
      let input: { messages?: { role?: string; content?: unknown }[]; stream?: boolean };
      try { input = JSON.parse(body); } catch { json({ error: 'Invalid JSON' }, 400); return; }
      const userText = input.messages?.filter(message => message.role === 'user').map(message => String(message.content)).join('\n') || '';
      if (!userText.includes('SYNTHETIC')) { json({ error: 'Only synthetic fixture reports are accepted' }, 422); return; }
      requests.ai++;
      const extraction = input.messages?.some(message => String(message.content).includes('You are a lab report data extraction assistant'));
      if (extraction) { requests.extraction++; await options.beforeExtraction?.(); }
      const content = JSON.stringify(extraction ? { testType: 'blood', labName: 'Synthetic Laboratory', date: userText.includes('2026-02-12') ? '2026-02-12' : '2026-01-12', sampleTime: null, fasting: null,
        markers: [{ rawName: 'Glucose', value: 5.2, mappedKey: 'biochemistry.glucose', unit: 'mmol/l', refMin: 3.9, refMax: 5.6 },
          { rawName: 'Ferritin', value: 65, mappedKey: 'iron.ferritin', unit: 'ng/ml', refMin: 20, refMax: 200 }] } : { testType: 'blood', labName: 'Synthetic Laboratory' });
      const usage = { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 };
      if (input.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n');
      } else json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage });
      return;
    }
    json({ error: 'Not found' }, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
