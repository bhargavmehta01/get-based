// @vitest-environment jsdom
import {IDBFactory} from 'fake-indexeddb';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {state} from '../js/state.js';
import {runPostProfileStartupMaintenance} from '../js/startup-maintenance.js';
import {createDefaultProfileData} from '../js/profile.js';
import {saveImportedData} from '../js/data.js';
import {encryptedGetItem} from '../js/crypto.js';
import {logManualMetric, logManualBP, deleteManualMetric, deleteAllManualMetrics, parseManualMirrorEntry} from '../js/wearables-manual.js';
import {applyPulledManualBodyReadings, catchUpManualBodyReadings} from '../js/wearables-manual-sync.js';
import * as manualStore from '../js/wearables-store.js';
import {getDaily, getMeta, clearSource, upsertDaily, deleteWearablesDB, configureWearablesStoreCrypto} from '../js/wearables-store.js';
import {mergeImportedData} from '../js/data-merge.js';
import {mergeMapRowsIntoImported} from '../js/sync-delta-map-merge.js';
import {_planKeyedMapDelta, DELTA_MAPS} from '../js/sync-delta.js';
import {buildClientExportObject} from '../js/export.js';
const profile = 'manual-sync-test', date = '2026-09-21', key = (metric: string) => `${metric}.${date}`;
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory(); localStorage.clear();
  state.currentProfile = profile; state.importedData = createDefaultProfileData();
  state.profiles = [{id: profile, name: 'Synthetic manual profile'}];
  localStorage.setItem('labcharts-active-profile', profile);
  expect(await saveImportedData()).toBe(true);
});
afterEach(async () => {vi.restoreAllMocks(); await deleteWearablesDB(profile); localStorage.clear();});
it('syncs distinct same-day weight, BP and pulse fields with manual context through the actual row codec', async () => {
  await logManualMetric(profile, 'weight', {date, value: 80, tags: ['resting'], note: 'Synthetic note'});
  await logManualBP(profile, {date, systolic: 120, diastolic: 80, pulse: 60});
  const mirror = structuredClone(state.importedData.manualBodyReadings!);
  expect(Object.keys(mirror)).toEqual(expect.arrayContaining([key('weight'), key('bp_systolic'), key('bp_diastolic'), key('rhr')]));
  expect(DELTA_MAPS).toContain('manualBodyReadings');
  const plan = await _planKeyedMapDelta(profile, 'manualBodyReadings', mirror);
  const received: Record<string, unknown> = {};
  await mergeMapRowsIntoImported(received, 'manualBodyReadings', plan.ops.map(op => ({...op.args, itemId: op.args.itemId as string, payload: op.args.payload})));
  await clearSource(profile, 'manual');
  const draft: Parameters<typeof applyPulledManualBodyReadings>[1] = {...createDefaultProfileData(), manualBodyReadings: received.manualBodyReadings as typeof mirror};
  await applyPulledManualBodyReadings(profile, draft);
  expect(await getDaily(profile, 'manual', date)).toMatchObject({weight: 80, bp_systolic: 120, bp_diastolic: 80, rhr: 60, tags: ['resting'], note: 'Synthetic note'});
  expect(draft.wearableConnections?.manual).toBeTruthy();
});
it('backfills only existing manual rows, add-only, and never treats an empty device as a deletion', async () => {
  await upsertDaily(profile, {source: 'manual', date, weight: 80, rhr: 60});
  await upsertDaily(profile, {source: 'withings', date, weight: 99, vendorSecret: 'RAW_VENDOR_SENTINEL'});
  state.importedData.manualBodyReadings = {[key('weight')]: {value: 81, updatedAt: 100}};
  await saveImportedData(); await catchUpManualBodyReadings(profile);
  expect(state.importedData.manualBodyReadings![key('weight')]!.value).toBe(81);
  expect(state.importedData.manualBodyReadings![key('rhr')]!.value).toBe(60);
  expect(JSON.stringify(state.importedData.manualBodyReadings)).not.toContain('RAW_VENDOR_SENTINEL');
  expect(await getMeta(profile, 'manual-body-readings-backfilled-v1')).toBeTruthy();
  const mirror = structuredClone(state.importedData.manualBodyReadings);
  await clearSource(profile, 'manual'); await catchUpManualBodyReadings(profile);
  expect(state.importedData.manualBodyReadings).toEqual(mirror);
  expect(await getDaily(profile, 'manual', date)).toMatchObject({weight: 81, rhr: 60});
});
it('retains field deletions and explicit re-adds without resurrecting stale local history', async () => {
  await logManualMetric(profile, 'weight', {date, value: 80});
  await logManualMetric(profile, 'rhr', {date, value: 60});
  await deleteManualMetric(profile, 'rhr', date);
  expect(state.importedData.manualBodyReadings![key('rhr')]!.value).toBeNull();
  await upsertDaily(profile, {source: 'manual', date, weight: 80, rhr: 55});
  await catchUpManualBodyReadings(profile);
  expect((await getDaily(profile, 'manual', date))?.rhr).toBeUndefined();
  await logManualMetric(profile, 'rhr', {date, value: 62});
  expect(state.importedData.manualMetricTombstones![key('rhr')]).toBe(0);
  expect(state.importedData.manualBodyReadings![key('rhr')]!.value).toBe(62);
  await deleteAllManualMetrics(profile); await catchUpManualBodyReadings(profile);
  expect(await getDaily(profile, 'manual', date)).toBeNull();
  expect(Object.values(state.importedData.manualBodyReadings!).every(entry => entry.value === null)).toBe(true);
});
it('keeps newer field edits across blob and stale row overlays while allowing newer remote edits', async () => {
  const local = {...createDefaultProfileData(), manualBodyReadings: {[key('weight')]: {value: 80, updatedAt: 200}}};
  const old = {...createDefaultProfileData(), manualBodyReadings: {[key('weight')]: {value: 75, updatedAt: 100}, [key('rhr')]: {value: 60, updatedAt: 100}}};
  const merged = mergeImportedData(local, old);
  expect(merged.manualBodyReadings![key('weight')]!.value).toBe(80);
  expect(merged.manualBodyReadings![key('rhr')]!.value).toBe(60);
  const overlay = (updatedAt: number, value: number) => mergeMapRowsIntoImported(merged, 'manualBodyReadings', [{itemId: key('weight'), payload: JSON.stringify({k: key('weight'), v: {value, updatedAt}}), syncedAt: '2026-09-21T00:00:00Z'}]);
  await overlay(100, 75); expect(merged.manualBodyReadings![key('weight')]!.value).toBe(80);
  await overlay(300, 82); expect(merged.manualBodyReadings![key('weight')]!.value).toBe(82);
});
it('preserves opaque future row fields and refuses malformed or unrelated inbound values', async () => {
  await upsertDaily(profile, {source: 'manual', date, weight: 80, futureField: {keep: true}});
  const draft = {...createDefaultProfileData(), manualBodyReadings: {[key('rhr')]: {value: 60, updatedAt: 100}, [key('weight')]: {value: 'bad', updatedAt: 100}, [key('vendorRaw')]: {value: 1, updatedAt: 100}}};
  await applyPulledManualBodyReadings(profile, draft);
  expect(await getDaily(profile, 'manual', date)).toMatchObject({weight: 80, rhr: 60, futureField: {keep: true}});
  expect((await getDaily(profile, 'manual', date))?.vendorRaw).toBeUndefined();
  expect(parseManualMirrorEntry('weight.2026-02-30', {value: 80, updatedAt: 1})).toBeNull();
  expect(parseManualMirrorEntry(key('weight'), {value: Infinity, updatedAt: 1})).toBeNull();
  expect(parseManualMirrorEntry(key('weight'), {value: 80, updatedAt: -1})).toBeNull();
});
it('does not mark an empty or locked store as successfully backfilled', async () => {
  await catchUpManualBodyReadings(profile);
  expect(await getMeta(profile, 'manual-body-readings-backfilled-v1')).toBeNull();
  const previous = configureWearablesStoreCrypto({getEncryptionEnabled: () => true, encryptObject: async () => null});
  try {
    const draft = {...createDefaultProfileData(), manualBodyReadings: {[key('weight')]: {value: 80, updatedAt: 100}}};
    await expect(applyPulledManualBodyReadings(profile, draft)).rejects.toThrow(/unlock|encrypted/i);
    expect(await getDaily(profile, 'manual', date)).toBeNull();
  } finally {configureWearablesStoreCrypto(previous);}
});
it('includes the manual mirror in portable exports while excluding raw vendor history', async () => {
  await logManualMetric(profile, 'weight', {date, value: 80});
  await upsertDaily(profile, {source: 'withings', date, weight: 90, vendorSecret: 'RAW_VENDOR_SENTINEL'});
  const exported = await buildClientExportObject(profile);
  expect(exported.manualBodyReadings).toEqual(state.importedData.manualBodyReadings);
  expect(JSON.stringify(exported)).not.toContain('RAW_VENDOR_SENTINEL');
});

it('catches up a synced manual reading on ordinary page startup without a profile switch', async () => {
  state.importedData.manualBodyReadings = {[key('weight')]: {value: 80, updatedAt: 100}};
  await saveImportedData();
  runPostProfileStartupMaintenance();
  await vi.waitFor(async () => expect(await getDaily(profile, 'manual', date)).toMatchObject({weight: 80}));
  await vi.waitFor(() => expect(state.importedData.wearableSummary?.metrics?.weight?.latest).toBe(80));
  expect(state.currentProfile).toBe(profile);
  await saveImportedData();
});

it('retains all same-day mirror fields after concurrent manual submissions', async () => {
  await Promise.all([logManualMetric(profile, 'weight', {date, value: 80}), logManualBP(profile, {date, systolic: 120, diastolic: 80, pulse: 60})]);
  for (const [metric, value] of Object.entries({weight: 80, bp_systolic: 120, bp_diastolic: 80, rhr: 60})) {
    expect(state.importedData.manualBodyReadings![key(metric)]!.value).toBe(value);
  }
});
it('preserves future metadata during editing and erases it with explicit deletion', async () => {
  state.importedData.manualBodyReadings = {[key('weight')]: {value: 80, updatedAt: 1, futureMetadata: 'Private future annotation'}};
  await saveImportedData(); await logManualMetric(profile, 'weight', {date, value: 81});
  expect(state.importedData.manualBodyReadings![key('weight')]!.futureMetadata).toBe('Private future annotation');
  await deleteAllManualMetrics(profile);
  expect(state.importedData.manualBodyReadings![key('weight')]).toEqual({value: null, updatedAt: expect.any(Number)});
});
it('keeps shared legacy context when deleting one of several unbackfilled manual metrics', async () => {
  await upsertDaily(profile, {source: 'manual', date, weight: 80, rhr: 60, note: 'Shared legacy note'});
  await deleteManualMetric(profile, 'rhr', date); await catchUpManualBodyReadings(profile);
  expect(await getDaily(profile, 'manual', date)).toMatchObject({weight: 80, note: 'Shared legacy note'});
  expect(state.importedData.manualBodyReadings![key('note')]!.value).toBe('Shared legacy note');
  expect(state.importedData.manualBodyReadings![key('rhr')]!.value).toBeNull();
});

it('retains the write-site rejection of dangerous raw map keys', async () => {
  const imported = {manualBodyReadings: {}};
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    await mergeMapRowsIntoImported(imported, 'manualBodyReadings', [{itemId: name, payload: JSON.stringify({k: name, v: {value: 80, updatedAt: 300}})}]);
    expect(Object.hasOwn(imported.manualBodyReadings, name)).toBe(false);
  }
  expect(Object.getPrototypeOf(imported.manualBodyReadings)).toBe(Object.prototype);
});

it.each(['edit', 'delete-all'])('keeps a concurrent %s that commits after the legacy scan starts', async operation => {
  await upsertDaily(profile, {source: 'manual', date, weight: 80});
  let scanned!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => {scanned = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const original = manualStore.getDailyRange;
  vi.spyOn(manualStore, 'getDailyRange').mockImplementationOnce(async (...args) => {
    const rows = await original(...args); scanned(); await gate; return rows;
  });
  const backfill = catchUpManualBodyReadings(profile);
  await ready;
  if (operation === 'edit') await logManualMetric(profile, 'weight', {date, value: 82});
  else await deleteAllManualMetrics(profile);
  release(); await backfill;
  const stored = JSON.parse((await encryptedGetItem(`labcharts-${profile}-imported`))!) as typeof state.importedData;
  if (operation === 'edit') {
    expect(stored.manualBodyReadings![key('weight')]).toMatchObject({value: 82, updatedAt: expect.any(Number)});
    expect(stored.manualBodyReadings![key('weight')]!.updatedAt).toBeGreaterThan(0);
    expect(await getDaily(profile, 'manual', date)).toMatchObject({weight: 82});
  } else {
    expect(stored.manualBodyReadings![key('weight')]).toBeUndefined();
    expect(stored.manualMetricTombstones!['weight.all']).toBeGreaterThan(0);
    expect(await getDaily(profile, 'manual', date)).toBeNull();
  }
});
