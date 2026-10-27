// auto-import-feed-runtime.js — fetches a configured auto-import source and
// hands new PDF reports to the existing batch import + review flow.
//
// Nothing here runs unless the user saved a feed address for the active
// profile. Items are marked done only after the review flow reports that the
// file was saved or explicitly skipped, so failed or postponed reports are
// offered again on the next check.

import { state } from './state.js';
import { showConfirmDialog, showNotification, isDebugMode } from './utils.js';
import { loadImportUI } from './import-loader.js';
import { importDispatch } from './pdf-import-progress.js';
import { isDropZoneImportRunning } from './import-drop-zone-runtime.js';
import {
  AUTO_IMPORT_FEED_MAX_PER_CHECK,
  AutoImportFeedError,
  autoImportFileName,
  hasPdfSignature,
  isAllowedAutoImportUrl,
  markAutoImportItemsDone,
  parseAutoImportFeed,
  readAutoImportFeedConfig,
  recordAutoImportCheck,
  selectNewAutoImportItems,
  type AutoImportFeedItem,
} from './auto-import-feed.js';

const FEED_TIMEOUT_MS = 15000;
const PDF_TIMEOUT_MS = 60000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;

export type AutoImportCheckStatus = 'off' | 'busy' | 'none' | 'postponed' | 'started' | 'error';

export interface AutoImportFeedRuntimeDependencies {
  fetch: typeof fetch;
  confirm: typeof showConfirmDialog;
  notify: typeof showNotification;
  loadImportUI: () => Promise<Pick<Awaited<ReturnType<typeof loadImportUI>>, 'handleBatchPDFs'>>;
  isImportRunning: () => boolean;
}

const defaultDeps = (): AutoImportFeedRuntimeDependencies => ({
  fetch: (...args) => globalThis.fetch(...args),
  confirm: showConfirmDialog,
  notify: showNotification,
  loadImportUI,
  isImportRunning: isDropZoneImportRunning,
});

let deps: AutoImportFeedRuntimeDependencies = defaultDeps();
let inFlight: Promise<AutoImportCheckStatus> | null = null;

export function configureAutoImportFeedRuntimeDeps(next: Partial<AutoImportFeedRuntimeDependencies> = {}): AutoImportFeedRuntimeDependencies {
  const previous = deps;
  deps = { ...defaultDeps(), ...next };
  return previous;
}

class AutoImportTimeoutError extends Error {
  constructor() {
    super('Request timed out');
    this.name = 'AutoImportTimeoutError';
  }
}

/**
 * Fetch `url` and read its body with one deadline covering headers and body.
 * The request is aborted when the deadline passes, and the read is abandoned
 * even if a fetch implementation ignores the abort signal.
 */
async function fetchAndRead<T>(
  url: string,
  timeoutMs: number,
  accept: string,
  trustedOrigins: readonly string[],
  read: (response: Response, signal: AbortSignal | null) => Promise<T>,
): Promise<T> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new AutoImportTimeoutError());
    }, timeoutMs);
  });
  const work = (async () => {
    const response = await deps.fetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: accept },
      ...(controller ? { signal: controller.signal } : {}),
    });
    // A redirect must not lead the request outside the address policy.
    if (response.redirected && response.url && !isAllowedAutoImportUrl(response.url, trustedOrigins)) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Request was redirected to an address that is not allowed');
    }
    return read(response, controller?.signal ?? null);
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read a response body, stopping as soon as it exceeds `maxBytes`. Falls back
 * to a buffered read (checked after the fact) when no body stream is exposed.
 */
export async function readAutoImportBody(response: Response, maxBytes: number, signal: AbortSignal | null = null): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Response is too large');
  }
  const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error('Response is too large');
    return buffer;
  }
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (signal?.aborted) throw new AutoImportTimeoutError();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error('Response is too large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function originOf(href: string): string | null {
  try { return new URL(href).origin; } catch (_) { return null; }
}

function appOrigin(): string | null {
  return originOf(globalThis.location?.href || '');
}

export async function fetchAutoImportFeed(feedUrl: string): Promise<AutoImportFeedItem[]> {
  const trusted = [appOrigin(), originOf(feedUrl)].filter((origin): origin is string => Boolean(origin));
  const doc = await fetchAndRead(feedUrl, FEED_TIMEOUT_MS, 'application/json', trusted, async (response, signal) => {
    if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
    const bytes = await readAutoImportBody(response, MAX_FEED_BYTES, signal);
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (_) {
      throw new AutoImportFeedError('Feed is not valid JSON');
    }
  });
  return parseAutoImportFeed(doc, feedUrl);
}

export async function downloadAutoImportPdf(item: AutoImportFeedItem, feedUrl?: string): Promise<File> {
  const trusted = [appOrigin(), originOf(feedUrl || item.url)].filter((origin): origin is string => Boolean(origin));
  const bytes = await fetchAndRead(item.url, PDF_TIMEOUT_MS, 'application/pdf', trusted, async (response, signal) => {
    if (!response.ok) throw new Error(`Report download returned HTTP ${response.status}`);
    return readAutoImportBody(response, MAX_PDF_BYTES, signal);
  });
  if (!hasPdfSignature(bytes.subarray(0, 8))) throw new Error('Report is not a PDF');
  const created = item.created ? Date.parse(item.created) : NaN;
  return new File([bytes as BlobPart], autoImportFileName(item), {
    type: 'application/pdf',
    ...(Number.isFinite(created) ? { lastModified: created } : {}),
  });
}

function isImportBusy(): boolean {
  return importDispatch.busy || deps.isImportRunning();
}

/**
 * Check the active profile's auto-import source. `interactive` is true for the
 * Settings "Check now" button; startup checks stay silent unless there is
 * something to review or a short error notice to show.
 */
export function checkAutoImportFeed(options: { interactive?: boolean } = {}): Promise<AutoImportCheckStatus> {
  if (inFlight) return inFlight;
  inFlight = runCheck(Boolean(options.interactive)).finally(() => { inFlight = null; });
  return inFlight;
}

async function runCheck(interactive: boolean): Promise<AutoImportCheckStatus> {
  const profileId = state.currentProfile;
  const config = readAutoImportFeedConfig(profileId);
  if (!config.url) return 'off';
  if (isImportBusy()) {
    if (interactive) deps.notify('An import is already running. Check the auto-import source again when it finishes.', 'info');
    return 'busy';
  }

  let listed: AutoImportFeedItem[];
  try {
    listed = await fetchAutoImportFeed(config.url);
  } catch (err) {
    if (isDebugMode()) console.warn('[auto-import] feed check failed:', err);
    if (state.currentProfile !== profileId) return 'off';
    recordAutoImportCheck(profileId, err instanceof AutoImportFeedError ? err.message : 'Could not reach the auto-import source');
    deps.notify('Auto-import: could not check the configured source.', 'error', 4000);
    return 'error';
  }
  if (state.currentProfile !== profileId) return 'off';
  // Handled ids are filtered over the whole feed before the per-check limit.
  const pending = selectNewAutoImportItems(listed, readAutoImportFeedConfig(profileId).doneIds);
  const listedIds = listed.map(item => item.id);
  recordAutoImportCheck(profileId, pending.length ? `${pending.length} new report(s) found` : 'No new reports');
  if (!pending.length) {
    if (interactive) deps.notify('Auto-import: no new reports.', 'info');
    return 'none';
  }
  const fresh = pending.slice(0, AUTO_IMPORT_FEED_MAX_PER_CHECK);

  const noun = pending.length === 1 ? 'report is' : 'reports are';
  const batchNote = pending.length > fresh.length
    ? ` The oldest ${fresh.length} will be reviewed now; the rest are offered on the next check.`
    : '';
  const proceed = await deps.confirm(
    `${pending.length} new lab ${noun} available from your auto-import source.${batchNote}\n\nReview now? Each report goes through the usual import review, and nothing is saved until you confirm it.`,
    { confirmLabel: 'Review now', cancelLabel: 'Later', tone: 'primary', ariaLabel: 'Review auto-imported reports' },
  );
  if (!proceed || state.currentProfile !== profileId) return 'postponed';
  if (isImportBusy()) {
    deps.notify('An import is already running. New reports will be offered again later.', 'info');
    return 'busy';
  }

  const files: File[] = [];
  const idsByFile = new Map<File, string>();
  let downloadFailures = 0;
  for (const item of fresh) {
    try {
      const file = await downloadAutoImportPdf(item, config.url);
      files.push(file);
      idsByFile.set(file, item.id);
    } catch (err) {
      if (isDebugMode()) console.warn('[auto-import] report download failed:', err);
      downloadFailures++;
    }
    if (state.currentProfile !== profileId) return 'off';
  }
  if (downloadFailures) deps.notify(`Auto-import: ${downloadFailures} report(s) could not be downloaded and will be retried later.`, 'error', 4000);
  if (!files.length) return 'error';

  let importModule: Awaited<ReturnType<AutoImportFeedRuntimeDependencies['loadImportUI']>>;
  try {
    importModule = await deps.loadImportUI();
  } catch (err) {
    if (isDebugMode()) console.error('[auto-import] could not load import UI:', err);
    deps.notify('Could not load import UI. Reload the app to finish updating, then try again.', 'error');
    return 'error';
  }
  if (state.currentProfile !== profileId) return 'off';
  // A manual import may have started while reports were downloading or the
  // import UI was loading. Recheck and claim the shared import lock with no
  // await in between; if it is taken, record nothing and offer again later.
  if (isImportBusy()) {
    deps.notify('An import is already running. New reports will be offered again later.', 'info');
    return 'busy';
  }

  importDispatch.busy = true;
  try {
    await importModule.handleBatchPDFs(files, {
      onFileResult: (file, outcome) => {
        const id = idsByFile.get(file);
        // Saved or explicitly skipped in review: never offer again. Failures retry next check.
        if (id && outcome !== 'failed') markAutoImportItemsDone(profileId, [id], listedIds);
      },
    });
  } finally {
    importDispatch.busy = false;
  }
  return 'started';
}

/** Startup hook: a no-op (and no network request) unless a source is configured. */
export function startAutoImportFeed(): void {
  void checkAutoImportFeed({ interactive: false }).catch(err => {
    if (isDebugMode()) console.warn('[auto-import] startup check failed:', err);
  });
}
