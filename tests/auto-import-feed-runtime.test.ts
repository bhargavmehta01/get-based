// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { state } from '../js/state.js';
import { readAutoImportFeedConfig, saveAutoImportFeedUrl } from '../js/auto-import-feed.js';
import { checkAutoImportFeed, configureAutoImportFeedRuntimeDeps } from '../js/auto-import-feed-runtime.js';
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
});
