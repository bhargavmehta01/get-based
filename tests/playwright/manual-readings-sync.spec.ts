import {expect, test} from './coverage-fixture.js';
import {createDefaultProfileData} from '../../js/profile.js';

test('ordinary startup materializes incoming manual readings and the detail view survives a local-row reset', async ({page}) => {
  const date = '2026-09-21';
  const mirror = Object.fromEntries(Object.entries({weight: 80, bp_systolic: 120, bp_diastolic: 80, rhr: 60, note: 'Synthetic manual context'}).map(([field, value]) => [`${field}.${date}`, {value, updatedAt: 100}]));
  const seed = {...createDefaultProfileData(), entries: [{date, markers: {'biochemistry.glucose': 5.2}}], manualBodyReadings: mirror};
  await page.clock.setFixedTime(new Date('2026-10-20T12:00:00Z'));
  await page.addInitScript(seed => {
    localStorage.setItem('labcharts-profiles', JSON.stringify([{id: 'default', name: 'Synthetic profile'}]));
    localStorage.setItem('labcharts-active-profile', 'default');
    if (!localStorage.getItem('labcharts-default-imported')) localStorage.setItem('labcharts-default-imported', JSON.stringify(seed));
    for (const name of ['emptyTour', 'tour']) localStorage.setItem(`labcharts-default-${name}`, 'completed');
    localStorage.setItem('wearable-detail-range', 'all');
  }, seed);
  await page.goto('/app', {waitUntil: 'load'});
  const row = () => page.evaluate(async date => (await import('/js/wearables-store.js')).getDaily('default', 'manual', date), date);
  await expect.poll(row).toMatchObject({weight: 80, bp_systolic: 120, bp_diastolic: 80, rhr: 60, note: 'Synthetic manual context'});
  await expect.poll(() => page.evaluate(async () => (await import('/js/state.js')).state.importedData.wearableSummary?.metrics?.weight?.latest)).toBe(80);
  await page.evaluate(async () => {await (await import('/js/data.js')).saveImportedData(); await (await import('/js/wearables-store.js')).clearSource('default', 'manual');});
  expect(await row()).toBeNull();
  await page.reload({waitUntil: 'load'});
  await expect.poll(row).toMatchObject({weight: 80, bp_systolic: 120, bp_diastolic: 80, rhr: 60});
  await page.evaluate(async () => {(await import('/js/chat-panel.js')).closeChatPanel(); await (await import('/js/wearables.js')).openWearableDetail('weight');});
  await expect(page.locator('#detail-modal .wearable-manual-entry')).toHaveCount(1);
  await expect(page.locator('#detail-modal .wearable-manual-entry')).toContainText('Synthetic manual context');
  expect(await page.evaluate(async () => (await import('/js/state.js')).state.importedData.entries)).toEqual(seed.entries);
});
