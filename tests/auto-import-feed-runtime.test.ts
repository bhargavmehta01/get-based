// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { state } from '../js/state.js';
import { markAutoImportItemsDone, readAutoImportFeedConfig, saveAutoImportFeedUrl } from '../js/auto-import-feed.js';
import { checkAutoImportFeed, configureAutoImportFeedRuntimeDeps, fetchAutoImportFeed, readAutoImportBody } from '../js/auto-import-feed-runtime.js';
import { importDispatch } from '../js/pdf-import-progress.js';
import type { BatchPDFOutcome } from '../js/pdf-import.js';

const FEED = 'https://docs.example.test/inbox/feed.json';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

type Deps = Parameters<typeof configureAutoImportFeedRuntimeDeps>[0];
let previous: ReturnType<typeof configureAutoImportFeedRuntimeDeps>;
let previousProfile: string;

function feedResponse(items: unknown[]) {
  return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function pdfResponse() {
  return new Response(PDF_BYTES.slice(), { status: 200, headers: { 'content-type': 'application/pdf' } });
}

function install(overrides: Deps = {}) {
  const notify = vi.fn();
  const confirm = vi.fn(async () => true);
  const handleBatchPDFs = vi.fn(async (_files: File[], _options?: { onFileResult?: (file: File, outcome: BatchPDFOutcome) => void }) => {});
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === FEED) return feedResponse([
      { id: '1', title: 'Report one', url: '/inbox/doc/1.pdf', created: '2026-01-01T00:00:00Z' },
      { id: '2', title: 'Report two', url: '/inbox/doc/2.pdf', created: '2026-02-01T00:00:00Z' },
      { id: '3', title: 'Report three', url: '/inbox/doc/3.pdf', created: '2026-03-01T00:00:00Z' },
    ]);
    return pdfResponse();
  });
  previous = configureAutoImportFeedRuntimeDeps({
    fetch: fetchMock as unknown as typeof fetch,
    confirm,
    notify,
    loadImportUI: async () => ({ handleBatchPDFs }) as never,
    isImportRunning: () => false,
    ...overrides,
  });
  return { notify, confirm, handleBatchPDFs, fetchMock };
}

beforeEach(() => {
  localStorage.clear();
  previousProfile = state.currentProfile;
  state.currentProfile = 'alpha';
});

afterEach(() => {
  vi.useRealTimers();
  importDispatch.busy = false;
  configureAutoImportFeedRuntimeDeps(previous);
  state.currentProfile = previousProfile;
  localStorage.clear();
});

describe('auto-import feed runtime', () => {
  it('makes no request when no source is configured', async () => {
    const { fetchMock } = install();
    expect(await checkAutoImportFeed()).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands new PDFs to batch review and marks only saved or skipped items done', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const { handleBatchPDFs, confirm } = install();
    handleBatchPDFs.mockImplementation(async (files, options) => {
      expect(files.map(file => file.name)).toEqual(['Report one.pdf', 'Report two.pdf', 'Report three.pdf']);
      expect(files.every(file => file.type === 'application/pdf')).toBe(true);
      options?.onFileResult?.(files[0]!, 'imported');
      options?.onFileResult?.(files[1]!, 'failed');
      options?.onFileResult?.(files[2]!, 'skipped');
    });
    expect(await checkAutoImportFeed()).toBe('started');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readAutoImportFeedConfig('alpha').doneIds).toEqual(['1', '3']);
  });

  it('offers only items that were not handled before', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const { handleBatchPDFs } = install();
    handleBatchPDFs.mockImplementation(async (files, options) => {
      for (const file of files) options?.onFileResult?.(file, 'imported');
    });
    await checkAutoImportFeed();
    handleBatchPDFs.mockClear();
    expect(await checkAutoImportFeed({ interactive: true })).toBe('none');
    expect(handleBatchPDFs).not.toHaveBeenCalled();
  });

  it('does not download or mark anything when review is postponed', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const { fetchMock, handleBatchPDFs } = install({ confirm: vi.fn(async () => false) });
    expect(await checkAutoImportFeed()).toBe('postponed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handleBatchPDFs).not.toHaveBeenCalled();
    expect(readAutoImportFeedConfig('alpha').doneIds).toEqual([]);
  });

  it('marks only same-origin requests for the service worker network pass-through', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return feedResponse([]);
    });
    install({ fetch: fetchMock as unknown as typeof fetch });
    const sameOrigin = new URL('/inbox/feed.json', location.href).href;
    await fetchAutoImportFeed(sameOrigin);
    await fetchAutoImportFeed(FEED);
    expect(seen.map(entry => entry.url)).toEqual([sameOrigin, FEED]);
    for (const entry of seen) expect(entry.init?.cache).toBe('no-store');
    expect(seen[0]?.init?.headers).toEqual({ Accept: 'application/json', 'X-GetBased-Fresh': 'auto-import' });
    // Cross-origin requests stay simple (no preflight) and never reach the worker cache.
    expect(seen[1]?.init?.headers).toEqual({ Accept: 'application/json' });
  });

  it('reports feed errors with a short notice and leaves history untouched', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const { notify } = install({ fetch: vi.fn(async () => new Response('nope', { status: 502 })) as unknown as typeof fetch });
    expect(await checkAutoImportFeed()).toBe('error');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('could not check'), 'error', 4000);
    expect(readAutoImportFeedConfig('alpha').lastStatus).toBe('Could not reach the auto-import source');
  });

  it('skips non-PDF downloads without marking them done', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === FEED
      ? feedResponse([{ id: '9', url: '/inbox/doc/9.pdf' }])
      : new Response('<html></html>', { status: 200 }));
    const { handleBatchPDFs, notify } = install({ fetch: fetchMock as unknown as typeof fetch });
    expect(await checkAutoImportFeed()).toBe('error');
    expect(handleBatchPDFs).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('could not be downloaded'), 'error', 4000);
    expect(readAutoImportFeedConfig('alpha').doneIds).toEqual([]);
  });

  it('waits for a running import instead of starting another', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const { fetchMock } = install({ isImportRunning: () => true });
    expect(await checkAutoImportFeed()).toBe('busy');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not start a second batch when a manual import claims the lock while reports load', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const handleBatchPDFs = vi.fn(async () => {});
    const { notify } = install({
      loadImportUI: async () => {
        importDispatch.busy = true; // a manual import started meanwhile
        return { handleBatchPDFs } as never;
      },
    });
    expect(await checkAutoImportFeed()).toBe('busy');
    expect(handleBatchPDFs).not.toHaveBeenCalled();
    expect(importDispatch.busy).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('offered again later'), 'info');
    expect(readAutoImportFeedConfig('alpha').doneIds).toEqual([]);
  });

  it('holds the import lock only while its own batch runs', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const { handleBatchPDFs } = install();
    handleBatchPDFs.mockImplementation(async () => { expect(importDispatch.busy).toBe(true); });
    expect(await checkAutoImportFeed()).toBe('started');
    expect(importDispatch.busy).toBe(false);
  });

  it('filters handled ids over the whole feed before applying the per-check limit', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const entries = Array.from({ length: 640 }, (_, i) => ({ id: String(i + 1), title: `R${i + 1}`, url: `/inbox/doc/${i + 1}.pdf` }));
    markAutoImportItemsDone('alpha', entries.slice(0, 560).map(entry => entry.id));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === FEED ? feedResponse(entries) : pdfResponse());
    const confirm = vi.fn(async (_message: string) => true);
    const { handleBatchPDFs } = install({ fetch: fetchMock as unknown as typeof fetch, confirm });
    handleBatchPDFs.mockImplementation(async (files, options) => {
      for (const file of files) options?.onFileResult?.(file, 'imported');
    });
    expect(await checkAutoImportFeed()).toBe('started');
    expect(confirm.mock.calls[0]![0]).toContain('80 new lab reports');
    expect(confirm.mock.calls[0]![0]).toContain('oldest 50');
    expect(handleBatchPDFs.mock.calls[0]![0].map((file: File) => file.name)[0]).toBe('R561.pdf');
    expect(handleBatchPDFs.mock.calls[0]![0]).toHaveLength(50);

    handleBatchPDFs.mockClear();
    expect(await checkAutoImportFeed()).toBe('started');
    expect(handleBatchPDFs.mock.calls[0]![0]).toHaveLength(30);
    expect(handleBatchPDFs.mock.calls[0]![0][0]!.name).toBe('R611.pdf');
    expect(await checkAutoImportFeed()).toBe('none');
  });

  it('records a clear status for malformed feeds', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    install({ fetch: vi.fn(async () => new Response('{"documents":[]}', { status: 200 })) as unknown as typeof fetch });
    expect(await checkAutoImportFeed()).toBe('error');
    expect(readAutoImportFeedConfig('alpha').lastStatus).toBe('Feed is not in the expected format');
  });

  it('stops reading an oversized body without buffering it', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    await expect(readAutoImportBody(new Response(body), 3 * 1024 * 1024)).rejects.toThrow('too large');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it('rejects declared oversized bodies and reads small bodies without a stream', async () => {
    await expect(readAutoImportBody(new Response('x'.repeat(10), { headers: { 'content-length': '999' } }), 100)).rejects.toThrow('too large');
    const streamless = { headers: new Headers(), body: null, arrayBuffer: async () => PDF_BYTES.slice().buffer } as unknown as Response;
    expect(Array.from(await readAutoImportBody(streamless, 100))).toEqual(Array.from(PDF_BYTES));
    const big = { headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(101) } as unknown as Response;
    await expect(readAutoImportBody(big, 100)).rejects.toThrow('too large');
  });

  it('skips a report whose download exceeds the cap without a content length', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    let cancelled = false;
    const chunk = new Uint8Array(8 * 1024 * 1024);
    chunk.set(PDF_BYTES);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === FEED
      ? feedResponse([{ id: '7', url: '/inbox/doc/7.pdf' }])
      : new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(chunk); },
        cancel() { cancelled = true; },
      }), { status: 200 }));
    const { handleBatchPDFs, notify } = install({ fetch: fetchMock as unknown as typeof fetch });
    expect(await checkAutoImportFeed()).toBe('error');
    expect(cancelled).toBe(true);
    expect(handleBatchPDFs).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('could not be downloaded'), 'error', 4000);
  });

  it('keeps the timeout active while the body is read so a stalled feed cannot block later checks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    saveAutoImportFeedUrl('alpha', FEED);
    let signal: AbortSignal | undefined;
    const stalled = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ start() { /* headers arrived, body never does */ } }), { status: 200 });
    });
    const { notify } = install({ fetch: stalled as unknown as typeof fetch });
    const pending = checkAutoImportFeed({ interactive: true });
    await vi.advanceTimersByTimeAsync(15001);
    expect(await pending).toBe('error');
    expect(signal?.aborted).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('could not check'), 'error', 4000);
    // The in-flight check was released, so Check now starts a new request.
    void checkAutoImportFeed({ interactive: true });
    expect(stalled).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15001);
  });

  it('rejects responses redirected outside the address policy', async () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === FEED) return feedResponse([{ id: '5', url: '/inbox/doc/5.pdf' }]);
      const response = pdfResponse();
      Object.defineProperty(response, 'redirected', { value: true });
      Object.defineProperty(response, 'url', { value: 'http://192.168.1.20/doc/5.pdf' });
      return response;
    });
    const { handleBatchPDFs } = install({ fetch: fetchMock as unknown as typeof fetch });
    expect(await checkAutoImportFeed()).toBe('error');
    expect(handleBatchPDFs).not.toHaveBeenCalled();
  });
});
