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
  autoImportFileName,
  hasPdfSignature,
  markAutoImportItemsDone,
  parseAutoImportFeed,
  readAutoImportFeedConfig,
  recordAutoImportCheck,
  selectNewAutoImportItems,
  type AutoImportFeedItem,
} from './auto-import-feed.js';

const FEED_TIMEOUT_MS = 15000;
const PDF_TIMEOUT_MS = 60000;
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

async function fetchWithTimeout(url: string, timeoutMs: number, accept: string): Promise<Response> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await deps.fetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: accept },
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchAutoImportFeed(feedUrl: string): Promise<AutoImportFeedItem[]> {
  const response = await fetchWithTimeout(feedUrl, FEED_TIMEOUT_MS, 'application/json');
  if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
  return parseAutoImportFeed(await response.json(), feedUrl);
}

export async function downloadAutoImportPdf(item: AutoImportFeedItem): Promise<File> {
  const response = await fetchWithTimeout(item.url, PDF_TIMEOUT_MS, 'application/pdf');
  if (!response.ok) throw new Error(`Report download returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_PDF_BYTES) throw new Error('Report is too large');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES) throw new Error('Report is too large');
  if (!hasPdfSignature(new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength)))) throw new Error('Report is not a PDF');
  const created = item.created ? Date.parse(item.created) : NaN;
  return new File([buffer], autoImportFileName(item), {
    type: 'application/pdf',
    ...(Number.isFinite(created) ? { lastModified: created } : {}),
  });
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
  if (deps.isImportRunning()) {
    if (interactive) deps.notify('An import is already running. Check the auto-import source again when it finishes.', 'info');
    return 'busy';
  }

  let fresh: AutoImportFeedItem[];
  try {
    fresh = selectNewAutoImportItems(await fetchAutoImportFeed(config.url), config.doneIds);
  } catch (err) {
    if (isDebugMode()) console.warn('[auto-import] feed check failed:', err);
    recordAutoImportCheck(profileId, 'Could not reach the auto-import source');
    deps.notify('Auto-import: could not check the configured source.', 'error', 4000);
    return 'error';
  }
  if (state.currentProfile !== profileId) return 'off';
  recordAutoImportCheck(profileId, fresh.length ? `${fresh.length} new report(s) found` : 'No new reports');
  if (!fresh.length) {
    if (interactive) deps.notify('Auto-import: no new reports.', 'info');
    return 'none';
  }

  const noun = fresh.length === 1 ? 'report is' : 'reports are';
  const proceed = await deps.confirm(
    `${fresh.length} new lab ${noun} available from your auto-import source.\n\nReview now? Each report goes through the usual import review, and nothing is saved until you confirm it.`,
    { confirmLabel: 'Review now', cancelLabel: 'Later', tone: 'primary', ariaLabel: 'Review auto-imported reports' },
  );
  if (!proceed || state.currentProfile !== profileId) return 'postponed';
  if (deps.isImportRunning()) {
    deps.notify('An import is already running. New reports will be offered again later.', 'info');
    return 'busy';
  }

  const files: File[] = [];
  const idsByFile = new Map<File, string>();
  let downloadFailures = 0;
  for (const item of fresh) {
    try {
      const file = await downloadAutoImportPdf(item);
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

  importDispatch.busy = true;
  try {
    await importModule.handleBatchPDFs(files, {
      onFileResult: (file, outcome) => {
        const id = idsByFile.get(file);
        // Saved or explicitly skipped in review: never offer again. Failures retry next check.
        if (id && outcome !== 'failed') markAutoImportItemsDone(profileId, [id]);
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
