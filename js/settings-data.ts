import { importBenchmarkStorageId } from './import-benchmark-data.js';
export { importBenchmarkStorageId, importBenchmarkModelIdentity, importBenchmarksUseSameInput, isImportBenchmarkComparable, latestCompatibleModelTests, referenceDifferenceLabel } from './import-benchmark-data.js';
export { renderImportBenchmarksBody, renderReferenceDiscrepancyDetails, updateImportBenchmarkSelection } from './import-benchmark-facade.js';
import type { SettingsBenchmarkReader, SnapshotOperations } from '../types/settings-data.js';
// settings-data.js - Settings data-entry management and AI usage helpers.

import { state } from './state.js';
import { addUtilsRuntimeListener } from './utils-runtime.js';
import { showNotification, showConfirmDialog, isDebugMode, setPIIReviewEnabled, bindSyncAppliedRefresh } from './utils.js';
import { resetProfileUsage } from './schema.js';
import { loadPdfImport } from './import-loader.js';
import { refreshDataEntriesView, refreshAIUsageView, refreshAutoImportFeedView } from './settings-records-component.js';
import { clearAutoImportHistory, normalizeAutoImportFeedUrl, saveAutoImportFeedUrl } from './auto-import-feed.js';
import {
  getDeletedImportBenchmarkIds,
  getImportBenchmarks,
  recoverConfirmedImportBenchmarks,
} from './import-benchmarks.js';
import {
  getBundledImportReferenceGoldBenchmark,
} from './import-reference-benchmark.js';

export function prepareDataEntriesSection(): void {
  queueMicrotask(refreshDataEntriesView);
}
export function renderDataEntriesSection(): string {
  prepareDataEntriesSection();
  return '<div id="data-entries-content"></div>';
}
export function refreshDataEntriesSection(): void { refreshDataEntriesView(); }

export function saveAutoImportFeedFromSettings(): void {
  const field = document.getElementById('auto-import-feed-url') as HTMLInputElement | null;
  const url = normalizeAutoImportFeedUrl(field?.value ?? '', globalThis.location?.href || 'http://localhost/');
  if (url === null) { showNotification('Enter an http(s) feed URL, or leave it empty to turn auto-import off.', 'error'); return; }
  if (!saveAutoImportFeedUrl(state.currentProfile, url)) { showNotification('Could not save the auto-import source.', 'error'); return; }
  refreshAutoImportFeedView();
  showNotification(url ? 'Auto-import source saved. It is checked when the app opens.' : 'Auto-import turned off.', 'success');
}

export async function checkAutoImportFeedFromSettings(): Promise<void> {
  try {
    const { checkAutoImportFeed } = await import('./auto-import-feed-runtime.js');
    await checkAutoImportFeed({ interactive: true });
  } catch (err) {
    if (isDebugMode()) console.error('Auto-import check failed:', err);
    showNotification('Auto-import: could not check the configured source.', 'error');
  }
  refreshAutoImportFeedView();
  refreshDataEntriesView();
}

export async function clearAutoImportHistoryFromSettings(): Promise<void> {
  const confirmed = await showConfirmDialog('Forget which feed reports were already imported or skipped? They will be offered for review again on the next check.', { confirmLabel: 'Forget', tone: 'primary' });
  if (!confirmed) return;
  clearAutoImportHistory(state.currentProfile);
  refreshAutoImportFeedView();
}

export async function removeImportedEntryFromSettings(date: unknown) {
  try {
    const { removeImportedEntry } = await loadPdfImport();
    const ok = await (removeImportedEntry as (date:unknown)=>ReturnType<typeof removeImportedEntry>)(date);
    if (ok) refreshDataEntriesSection();
  } catch (err) {
    if (isDebugMode()) console.error('Remove imported entry failed:', err);
    showNotification('Could not remove imported data. Reload and try again.', 'error');
  }
}

export async function renameImportedEntryDateFromSettings(date: unknown) {
  try {
    const { renameImportedEntryDate } = await loadPdfImport();
    const ok = await (renameImportedEntryDate as (date:unknown)=>ReturnType<typeof renameImportedEntryDate>)(date);
    if (ok) refreshDataEntriesSection();
  } catch (err) {
    if (isDebugMode()) console.error('Rename imported entry failed:', err);
    showNotification('Could not edit the import date. Reload and try again.', 'error');
  }
}

export function getImportBenchmarkSnapshots(): unknown[] {
  const deletedIds = new Set(getDeletedImportBenchmarkIds());
  const snapshots = (state.importedData?.importSnapshots || []) as unknown as SnapshotOperations[];
  recoverConfirmedImportBenchmarks(snapshots);
  const attempts = getImportBenchmarks() as SettingsBenchmarkReader[];
  const legacy = snapshots.filter(snap => {
    if (!snap?.timings || !snap?.costInfo?.modelId) return false;
    if (attempts.some(item => item.id === snap.benchmarkId)) return false;
    return !deletedIds.has(importBenchmarkStorageId(snap))
      && !deletedIds.has(String(snap.benchmarkId || ''));
  });
  const stored = [...attempts, ...legacy]
    .filter(snap => !deletedIds.has(importBenchmarkStorageId(snap)))
    .sort((a, b) => ((b.benchmarkAt || b.importedAt || 0) as number) - ((a.benchmarkAt || a.importedAt || 0) as number));
  return [getBundledImportReferenceGoldBenchmark(), ...stored];
}
export function prepareAIUsageSection(): void {
  queueMicrotask(refreshAIUsageView);
}
export function renderAIUsageSection(): string {
  prepareAIUsageSection();
  return '<div id="ai-usage-content"></div>';
}
export function refreshAIUsageSection(): void { refreshAIUsageView(); }
export function resetCurrentProfileUsage(): void {
  resetProfileUsage(state.currentProfile);
  refreshAIUsageView();
}

// Disable confirmation for the PII review toggle. On->off shows a one-time
// warning so users do not silently lose visibility into what is leaving their
// device. Re-enabling and the initial setup are silent.
export async function confirmDisablePIIReview(checkbox:{checked:unknown}) {
  if (checkbox.checked) {
    setPIIReviewEnabled(true);
    return;
  }
  const acknowledged = localStorage.getItem('labcharts-pii-review-disable-ack') === '1';
  if (acknowledged) {
    setPIIReviewEnabled(false);
    return;
  }
  // Restore the toggle while the dialog is open; commit only on confirm.
  checkbox.checked = true;
  if (await showConfirmDialog(
    "Turn off the obfuscation review?\n\nWith this off, getbased's PII detector runs but you won't see the result before it's sent to the AI provider. Recommended only after you've verified the obfuscation works on your data."
  )) {
    localStorage.setItem('labcharts-pii-review-disable-ack', '1');
    setPIIReviewEnabled(false);
    checkbox.checked = false;
  }
}

// Mounted records follow the current profile after reload/sync without replacing DOM.
function refreshSettingsRecordsFromData(): void {
  refreshDataEntriesView(); refreshAIUsageView();
}
addUtilsRuntimeListener('labcharts-profile-switched', refreshSettingsRecordsFromData);
bindSyncAppliedRefresh(refreshSettingsRecordsFromData);
