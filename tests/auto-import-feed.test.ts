// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTO_IMPORT_FEED_MAX_DONE_IDS,
  AUTO_IMPORT_FEED_MAX_ENTRIES,
  AutoImportFeedError,
  autoImportFileName,
  clearAutoImportHistory,
  orderAutoImportPending,
  recordAutoImportFailures,
  withAutoImportFreshMarker,
  hasPdfSignature,
  isAutoImportFeedConfigured,
  markAutoImportItemsDone,
  normalizeAutoImportFeedUrl,
  parseAutoImportFeed,
  readAutoImportFeedConfig,
  recordAutoImportCheck,
  saveAutoImportFeedUrl,
  selectNewAutoImportItems,
} from '../js/auto-import-feed.js';

const FEED = 'https://docs.example.test/inbox/feed.json';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('auto-import feed parsing', () => {
  it('resolves item URLs against the feed and orders items oldest first', () => {
    const items = parseAutoImportFeed({
      items: [
        { id: 'b', title: 'Second', url: '/inbox/doc/b.pdf', created: '2026-03-02T10:00:00Z' },
        { id: 'a', title: 'First', url: 'doc/a.pdf', created: '2026-01-15T08:00:00Z' },
        { id: 'c', title: 'Absolute', url: 'https://files.example.test/c.pdf', created: '2026-02-01' },
      ],
    }, FEED);
    expect(items.map(item => item.id)).toEqual(['a', 'c', 'b']);
    expect(items[0]!.url).toBe('https://docs.example.test/inbox/doc/a.pdf');
    expect(items[2]!.url).toBe('https://docs.example.test/inbox/doc/b.pdf');
    expect(items[1]!.url).toBe('https://files.example.test/c.pdf');
  });

  it('drops malformed, duplicate and non-http items and accepts numeric ids', () => {
    const items = parseAutoImportFeed({
      items: [
        null,
        'nope',
        { id: '', url: '/x.pdf' },
        { id: 'no-url' },
        { id: 'js', url: 'javascript:alert(1)' },
        { id: 'data', url: 'data:application/pdf;base64,JVBERi0=' },
        { id: 7, url: '/seven.pdf', created: 'not a date' },
        { id: '7', url: '/duplicate.pdf' },
        { id: 'plain-http', url: 'http://elsewhere.example.test/p.pdf' },
        { id: 'creds', url: 'https://user:pw@files.example.test/p.pdf' },
        { id: 'untitled', url: '/u.pdf' },
      ],
    }, FEED);
    expect(items.map(item => item.id)).toEqual(['7', 'untitled']);
    expect(items[0]!.created).toBeNull();
    expect(items[0]!.url).toBe('https://docs.example.test/seven.pdf');
    expect(items[1]!.title).toBe('Report untitled');
  });

  it('rejects documents without an items array', () => {
    expect(() => parseAutoImportFeed({}, FEED)).toThrow(AutoImportFeedError);
    expect(() => parseAutoImportFeed([], FEED)).toThrow(AutoImportFeedError);
    expect(() => parseAutoImportFeed(null, FEED)).toThrow(AutoImportFeedError);
    expect(parseAutoImportFeed({ items: [] }, FEED)).toEqual([]);
  });

  it('normalizes feed addresses and refuses unusable ones', () => {
    const base = 'https://app.example.test/app';
    expect(normalizeAutoImportFeedUrl('  ', base)).toBe('');
    expect(normalizeAutoImportFeedUrl('/inbox/feed.json', base)).toBe('https://app.example.test/inbox/feed.json');
    expect(normalizeAutoImportFeedUrl('http://localhost:4010/feed.json', base)).toBe('http://localhost:4010/feed.json');
    expect(normalizeAutoImportFeedUrl('ftp://example.test/feed.json', base)).toBeNull();
    expect(normalizeAutoImportFeedUrl('javascript:alert(1)', base)).toBeNull();
    expect(normalizeAutoImportFeedUrl('https://user:pass@example.test/feed.json', base)).toBeNull();
    expect(normalizeAutoImportFeedUrl('http://docs.example.test/feed.json', base)).toBeNull();
    expect(normalizeAutoImportFeedUrl('/feed.json', 'http://app.example.test/app')).toBe('http://app.example.test/feed.json');
  });

  it('builds safe PDF file names and checks the PDF signature', () => {
    expect(autoImportFileName({ id: '1', title: 'Panel: 01/02 <x>.PDF' })).toBe('Panel 01 02 x.pdf');
    expect(autoImportFileName({ id: '9', title: '///' })).toBe('report-9.pdf');
    expect(hasPdfSignature(new TextEncoder().encode('%PDF-1.7\n'))).toBe(true);
    expect(hasPdfSignature(new TextEncoder().encode('<html>'))).toBe(false);
    expect(hasPdfSignature(new Uint8Array())).toBe(false);
  });
});

describe('auto-import dedupe and storage', () => {
  it('is off by default and stores settings per profile', () => {
    expect(isAutoImportFeedConfigured('alpha')).toBe(false);
    expect(readAutoImportFeedConfig('alpha')).toEqual({ url: '', doneIds: [], failedIds: [], lastCheckedAt: null, lastStatus: null });
    expect(saveAutoImportFeedUrl('alpha', FEED)).toBe(true);
    expect(isAutoImportFeedConfigured('alpha')).toBe(true);
    expect(isAutoImportFeedConfigured('beta')).toBe(false);
    expect(localStorage.getItem('labcharts-alpha-autoImportFeedV1')).toContain(FEED);
    // startup-maintenance checks this marker without loading the feature modules.
    expect(localStorage.getItem('labcharts-alpha-autoImportFeedV1')).toContain('"url":"http');
  });

  it('skips items already imported or dismissed', () => {
    const items = parseAutoImportFeed({ items: [
      { id: '1', url: '/1.pdf' }, { id: '2', url: '/2.pdf' }, { id: '3', url: '/3.pdf' },
    ] }, FEED);
    saveAutoImportFeedUrl('alpha', FEED);
    markAutoImportItemsDone('alpha', ['1', '3']);
    markAutoImportItemsDone('alpha', ['3']);
    const config = readAutoImportFeedConfig('alpha');
    expect(config.doneIds).toEqual(['1', '3']);
    expect(selectNewAutoImportItems(items, config.doneIds).map(item => item.id)).toEqual(['2']);
    expect(selectNewAutoImportItems(items, readAutoImportFeedConfig('beta').doneIds)).toHaveLength(3);
  });

  it('keeps history when the address is cleared and can forget it explicitly', () => {
    saveAutoImportFeedUrl('alpha', FEED);
    markAutoImportItemsDone('alpha', ['1']);
    recordAutoImportCheck('alpha', 'No new reports', new Date('2026-01-01T00:00:00Z'));
    expect(readAutoImportFeedConfig('alpha').lastCheckedAt).toBe('2026-01-01T00:00:00.000Z');
    saveAutoImportFeedUrl('alpha', '');
    expect(isAutoImportFeedConfigured('alpha')).toBe(false);
    expect(readAutoImportFeedConfig('alpha').doneIds).toEqual(['1']);
    expect(readAutoImportFeedConfig('alpha').lastStatus).toBeNull();
    clearAutoImportHistory('alpha');
    expect(localStorage.getItem('labcharts-alpha-autoImportFeedV1')).toBeNull();
  });

  it('bounds the stored history', () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const ids = Array.from({ length: AUTO_IMPORT_FEED_MAX_DONE_IDS + 5 }, (_, i) => `id-${i}`);
    markAutoImportItemsDone('alpha', ids);
    const done = readAutoImportFeedConfig('alpha').doneIds;
    expect(done).toHaveLength(AUTO_IMPORT_FEED_MAX_DONE_IDS);
    expect(done[0]).toBe('id-5');
  });

  it('parses archives larger than 500 entries so later reports are not hidden', () => {
    const entries = Array.from({ length: 620 }, (_, i) => ({ id: i + 1, url: `/inbox/doc/${i + 1}.pdf` }));
    const items = parseAutoImportFeed({ items: entries }, FEED);
    expect(items).toHaveLength(620);
    const handled = Array.from({ length: 600 }, (_, i) => String(i + 1));
    expect(selectNewAutoImportItems(items, handled).map(item => item.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(601 + i)),
    );
  });

  it('rejects feeds above the hard cap with a clear error', () => {
    const entries = Array.from({ length: AUTO_IMPORT_FEED_MAX_ENTRIES + 1 }, (_, i) => ({ id: i, url: `/d/${i}.pdf` }));
    expect(() => parseAutoImportFeed({ items: entries }, FEED)).toThrow(AutoImportFeedError);
    expect(() => parseAutoImportFeed({ items: entries }, FEED)).toThrow(/more than/);
  });

  it('drops overlong ids', () => {
    const items = parseAutoImportFeed({ items: [{ id: 'x'.repeat(201), url: '/a.pdf' }, { id: 'ok', url: '/b.pdf' }] }, FEED);
    expect(items.map(item => item.id)).toEqual(['ok']);
  });

  it('evicts ids no longer in the feed before ids it still lists', () => {
    saveAutoImportFeedUrl('alpha', FEED);
    const listed = Array.from({ length: AUTO_IMPORT_FEED_MAX_DONE_IDS }, (_, i) => `live-${i}`);
    markAutoImportItemsDone('alpha', ['gone-1', 'gone-2']);
    markAutoImportItemsDone('alpha', listed.slice(0, -1), listed);
    markAutoImportItemsDone('alpha', listed.slice(-1), listed);
    const done = readAutoImportFeedConfig('alpha').doneIds;
    expect(done).toHaveLength(AUTO_IMPORT_FEED_MAX_DONE_IDS);
    expect(done).not.toContain('gone-1');
    expect(done).not.toContain('gone-2');
    expect(selectNewAutoImportItems(listed.map(id => ({ id, title: id, url: `${FEED}/${id}`, created: null })), done)).toEqual([]);
  });

  it('ignores corrupt stored settings', () => {
    localStorage.setItem('labcharts-alpha-autoImportFeedV1', '{not json');
    expect(readAutoImportFeedConfig('alpha').url).toBe('');
    localStorage.setItem('labcharts-alpha-autoImportFeedV1', JSON.stringify({ url: 5, doneIds: ['ok', 3] }));
    expect(readAutoImportFeedConfig('alpha')).toMatchObject({ url: '', doneIds: ['ok'] });
  });

  it('retries failed reports after ones that have not failed', () => {
    const items = parseAutoImportFeed({ items: [
      { id: '1', url: '/1.pdf' }, { id: '2', url: '/2.pdf' }, { id: '3', url: '/3.pdf' }, { id: '4', url: '/4.pdf' },
    ] }, FEED);
    const listed = items.map(item => item.id);
    saveAutoImportFeedUrl('alpha', FEED);
    recordAutoImportFailures('alpha', ['2', '1'], listed);
    recordAutoImportFailures('alpha', ['2'], listed);
    recordAutoImportFailures('alpha', ['gone'], listed);
    expect(readAutoImportFeedConfig('alpha').failedIds).toEqual(['1', '2']);
    expect(orderAutoImportPending(items, readAutoImportFeedConfig('alpha').failedIds).map(item => item.id)).toEqual(['3', '4', '1', '2']);
    markAutoImportItemsDone('alpha', ['1'], listed);
    expect(readAutoImportFeedConfig('alpha').failedIds).toEqual(['2']);
    clearAutoImportHistory('alpha');
    expect(readAutoImportFeedConfig('alpha').failedIds).toEqual([]);
  });

  it('marks addresses with a fragment that is never sent to a server', () => {
    expect(withAutoImportFreshMarker('https://app.example.test/inbox/1.pdf?x=1#page=2')).toBe('https://app.example.test/inbox/1.pdf?x=1#getbased-fresh=auto-import');
    expect(withAutoImportFreshMarker('not a url')).toBe('not a url');
  });
});
