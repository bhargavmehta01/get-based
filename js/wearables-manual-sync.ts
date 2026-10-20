import type {StoredWearableRow} from './wearable-storage-types.js';
// Lazy inbound/catch-up service. Only explicit manual fields cross this boundary.
import type {ProfileData} from '../types/app-state.js';
import type {WearableProfileMutation} from './wearable-persistence-types.js';
import {state} from './state.js';
import {getSyncAppOwner} from './sync-runtime.js';
import {isProfileReadBlocked} from './profile-load-safety.js';
import {queueManualRowWrite} from './wearables-manual-lock.js';
import {getDaily, getDailyRange, getMeta, setMeta, upsertDaily, deleteDaily} from './wearables-store.js';
import {
  MANUAL_METRICS, MANUAL_MIRROR_FIELDS, MANUAL_HISTORY_START, MANUAL_HISTORY_END,
  captureManualMutation, persistManualMutation, updateManualConnection,
  isManualMetricTombstoned, manualMirror, manualMirrorKey, mirrorManualPatch, parseManualMirrorEntry,
} from './wearables-manual.js';
type ManualData = WearableProfileMutation & Partial<Pick<ProfileData, 'manualBodyReadings' | 'manualMetricTombstones'>>;
type Entry = NonNullable<ReturnType<typeof parseManualMirrorEntry>>;
const BACKFILL_FLAG = 'manual-body-readings-backfilled-v1';
function ownership(profileId: string) {
  const live = state.importedData, owner = getSyncAppOwner();
  return () => state.currentProfile === profileId && state.importedData === live
    && !isProfileReadBlocked(profileId) && getSyncAppOwner() === owner;
}

/** The caller owns the merged draft; never expose it as live state across an await. */
export async function applyPulledManualBodyReadings(profileId: string, data: ManualData, current = ownership(profileId)) {
  if (!current()) return {written: 0, connected: false};
  const byDate = new Map<string, Entry[]>();
  for (const [key, raw] of Object.entries(data.manualBodyReadings || {})) {
    const entry = parseManualMirrorEntry(key, raw);
    if (!entry) continue;
    const entries = byDate.get(entry.date) || []; entries.push(entry); byDate.set(entry.date, entries);
  }
  return queueManualRowWrite(profileId, async () => {
    let written = 0, hasReadings = false;
    for (const [date, entries] of byDate) {
      if (!current()) break;
      const existing = await getDaily(profileId, 'manual', date);
      if (!current()) break;
      const next: StoredWearableRow = {...existing, source: 'manual', date};
      const clocks = existing?._manualSyncAt && typeof existing._manualSyncAt === 'object' ? {...existing._manualSyncAt as Record<string, unknown>} : {};
      for (const entry of entries) {
        const localClock = typeof clocks[entry.field] === 'number' ? clocks[entry.field] as number : -1;
        const deleted = MANUAL_METRICS.includes(entry.field) && isManualMetricTombstoned(entry.field, entry.date, data);
        if (!deleted && localClock > entry.updatedAt) continue;
        if (deleted || entry.value === null) delete next[entry.field];
        else next[entry.field] = entry.value;
        clocks[entry.field] = entry.updatedAt;
      }
      const measurable = MANUAL_METRICS.some(field => next[field] != null);
      hasReadings ||= measurable;
      if (!existing && !measurable) continue;
      next._manualSyncAt = clocks;
      if (JSON.stringify(next) === JSON.stringify(existing)) continue;
      // Preserve opaque future row fields; only known manual measurements/context are patched.
      const hasFutureFields = Object.keys(next).some(field => !['source', 'date', 'importedAt', '_manualSyncAt', ...MANUAL_MIRROR_FIELDS].includes(field));
      if (!measurable && !hasFutureFields) await deleteDaily(profileId, 'manual', date);
      else await upsertDaily(profileId, next);
      written++;
    }
    const connected = current() && hasReadings && !data.wearableConnections?.manual;
    if (connected) updateManualConnection(data);
    return {written, connected};
  });
}

/** Page load and profile switch share one add-only upgrade; empty/locked IDB never implies deletion. */
export async function catchUpManualBodyReadings(profileId: string) {
  const current = ownership(profileId);
  if (!current()) return {skipped: 'obsolete' as const};
  const {imported, baseData} = captureManualMutation(profileId);
  const applied = await applyPulledManualBodyReadings(profileId, imported);
  if (!current()) return {skipped: 'obsolete' as const};
  const backfilled = await getMeta(profileId, BACKFILL_FLAG);
  if (!current()) return {skipped: 'obsolete' as const};
  let added = 0, markBackfilled = false;
  if (!backfilled) {
    const rows = await getDailyRange(profileId, 'manual', MANUAL_HISTORY_START, MANUAL_HISTORY_END);
    if (!current()) return {skipped: 'obsolete' as const};
    const mirror = manualMirror(imported);
    for (const row of rows) for (const field of MANUAL_MIRROR_FIELDS) {
      if (row[field] == null || Object.hasOwn(mirror, manualMirrorKey(field, row.date))
          || (MANUAL_METRICS.includes(field) && isManualMetricTombstoned(field, row.date, imported))) continue;
      const key = manualMirrorKey(field, row.date);
      mirrorManualPatch(imported, row.date, {[field]: row[field]}, 0);
      if (Object.hasOwn(mirror, key)) added++;
    }
    // A locked read may be empty. Retry later rather than recording a false successful upgrade.
    markBackfilled = rows.length > 0;
  }
  if (added || applied.connected) {
    if (!imported.wearableConnections?.manual && added) updateManualConnection(imported);
    await persistManualMutation(profileId, imported, baseData);
  }
  if (!current()) return {skipped: 'obsolete' as const};
  if (markBackfilled) await setMeta(profileId, BACKFILL_FLAG, {at: Date.now()});
  return {written: applied.written, added};
}
