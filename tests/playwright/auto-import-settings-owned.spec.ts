import { expect, test } from './coverage-fixture.js';
import type { Page } from '@playwright/test';

async function openSourceSettings(page: Page) {
  await page.addInitScript(() => {
    for (const key of ['emptyTour', 'tour']) localStorage.setItem(`labcharts-default-${key}`, 'completed');
    localStorage.setItem('labcharts-theme', 'light');
  });
  const origin = new URL(test.info().project.use.baseURL || 'http://127.0.0.1:8000').origin;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });
  await page.goto('/app', { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-app-ready'));
  await page.evaluate(async () => { await (await import('/js/settings-loader.js')).openSettingsModal('data'); });
  await page.locator('#auto-import-feed-section').scrollIntoViewIfNeeded();
}

test('report source setup, draft, check, and disconnect use the real Settings actions', async ({ page }) => {
  let requests = 0;
  await openSourceSettings(page);
  await page.route('**/__test/report-feed*', async route => { requests++; await route.fulfill({ json: { items: [] } }); });
  const address = new URL('/__test/report-feed', page.url()).href;
  const panel = page.locator('#auto-import-feed-section');
  const field = panel.getByLabel('Report feed address');
  const check = panel.getByRole('button', { name: 'Check for reports', exact: true });
  await expect(panel.getByRole('button', { name: 'Save source', exact: true })).toBeDisabled();
  await expect(check).toBeDisabled();
  await expect(field).toHaveCSS('font-size', '13px');
  await expect(field).toHaveCSS('border-top-width', '1px');
  await page.screenshot({ path: test.info().outputPath('source-desktop-off.png') });

  await field.fill('/__test/report-feed');
  await panel.getByRole('button', { name: 'Save source', exact: true }).click();
  await expect(field).toHaveValue(address);
  await expect(check).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  expect(requests).toBe(0);

  await field.fill('https://unsaved.example/feed.json');
  await expect(check).toBeDisabled();
  await expect(panel).toContainText('Save your changes before checking');
  await page.evaluate(() => window.dispatchEvent(new Event('labcharts-profile-switched')));
  await expect(field).toHaveValue('https://unsaved.example/feed.json');
  await field.fill(address);
  await check.click();
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(async () => { await (await import('/js/settings-loader.js')).openSettingsModal('data'); });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByRole('status')).toContainText('No new reports');
  await panel.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(field).toHaveValue('');
  await expect(panel.getByRole('status')).toHaveText('Off');
  await expect(check).toBeDisabled();
  const config = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return (await import('/js/auto-import-feed.js')).readAutoImportFeedConfig(state.currentProfile);
  });
  expect(config.url).toBe('');
  expect(requests).toBe(1);
});

test.describe('report source touch layouts', () => {
  test.use({ hasTouch: true });
  test('theme tokens, disclosure, keyboard focus and narrow layouts remain usable', async ({ page }) => {
    await page.addInitScript({ path: 'node_modules/axe-core/axe.min.js' });
    await openSourceSettings(page);
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      const feed = await import('/js/auto-import-feed.js');
      feed.saveAutoImportFeedUrl(state.currentProfile, 'https://archive.example/labs/feed.json');
      feed.markAutoImportItemsDone(state.currentProfile, ['synthetic-report']);
      (await import('/js/settings-records-component.js')).refreshAutoImportFeedView();
    });
    const panel = page.locator('#auto-import-feed-section');
    const details = panel.locator('summary', { hasText: 'Source requirements' });
    await details.focus(); await details.press('Enter');
    await expect(panel.locator('code')).toBeVisible();
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 900 }, { width: 320, height: 800 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark', 'cyberterm', 'glass', 'synth-sunrise', 'neuromancer']) {
        await page.evaluate(async name => { await (await import('/js/theme.js')).setTheme(name); }, theme);
        await panel.scrollIntoViewIfNeeded();
        // Theme changes animate the existing button tokens. Assess the settled
        // theme after its finite color transitions, without disabling motion.
        await expect.poll(() => panel.evaluate(element => element.getAnimations({ subtree: true })
          .filter(animation => animation instanceof CSSTransition
            && animation.playState !== 'finished' && animation.playState !== 'idle').length),
        { message: `${theme}/${viewport.width} color transitions settled` }).toBe(0);
        expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), `${theme}/${viewport.width}`).toBe(true);
        for (const button of await panel.getByRole('button').all()) {
          const bounds = await button.boundingBox();
          if (bounds) expect(bounds.height, `${theme}/${viewport.width} touch target`).toBeGreaterThanOrEqual(44);
        }
        await panel.getByLabel('Report feed address').focus();
        await expect(panel.getByLabel('Report feed address')).toHaveCSS('outline-width', '2px');
        const violations = await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run: (selector: string, options: unknown) => Promise<{ violations: { id: string; nodes: { target: unknown; failureSummary?: string }[] }[] }> } }).axe;
          return (await axe.run('#auto-import-feed-section', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) }));
        });
        expect(violations, `${theme}/${viewport.width}`).toEqual([]);
        if (theme === 'light' && viewport.width !== 320) await page.screenshot({ path: test.info().outputPath(`source-${viewport.width}-configured.png`) });
      }
    }
  });
});
