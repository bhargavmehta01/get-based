// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { showConfirmDialog } from '../js/utils.js';
import { closeModalOverlay, openModalOverlay } from '../js/modal-lifecycle.js';

afterEach(() => document.body.replaceChildren());
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();

it('queues overlapping confirmations without replacing buttons or stranding either caller', async () => {
  const first = showConfirmDialog('Reset report history?');
  const firstButton = document.querySelector('#confirm-ok');
  const second = showConfirmDialog('Review reports?');
  expect(document.querySelector('#confirm-ok')).toBe(firstButton);
  expect(document.querySelector('#confirm-dialog-overlay')!.textContent).toContain('Reset report history?');
  click('#confirm-ok');
  expect(await first).toBe(true);
  expect(document.querySelector('#confirm-dialog-overlay')!.textContent).toContain('Review reports?');
  click('#confirm-cancel');
  expect(await second).toBe(false);
  const third = showConfirmDialog('Check again?');
  click('#confirm-ok');
  expect(await third).toBe(true);
});

it('waits behind a confirmation owned by another workflow', async () => {
  const overlay = document.createElement('div');
  overlay.id = 'confirm-dialog-overlay';
  overlay.innerHTML = '<div class="confirm-dialog"><button id="preflight-confirm">Preflight</button></div>';
  document.body.appendChild(overlay);
  openModalOverlay(overlay);
  const pending = showConfirmDialog('Review reports?');
  expect(document.querySelector('#preflight-confirm')).not.toBeNull();
  expect(document.querySelector('#confirm-ok')).toBeNull();
  closeModalOverlay(overlay);
  await Promise.resolve();
  click('#confirm-ok');
  expect(await pending).toBe(true);
});

it('settles a removed dialog and continues queued work', async () => {
  const first = showConfirmDialog('First');
  const second = showConfirmDialog('Second');
  document.getElementById('confirm-dialog-overlay')!.remove();
  expect(await first).toBe(false);
  expect(document.querySelector('#confirm-dialog-overlay')!.textContent).toContain('Second');
  click('#confirm-cancel');
  expect(await second).toBe(false);
});
