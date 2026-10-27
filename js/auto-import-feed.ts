// auto-import-feed.js — leaf model for the optional auto-import source.
//
// A feed is a small JSON document listing PDF lab reports published by a
// document manager the user runs (for example a self-hosted archive):
//   {"items":[{"id":"42","title":"Report","url":"/feed/42.pdf","created":"2026-01-02T00:00:00Z"}]}
// This module owns parsing, per-profile settings storage and dedupe. It makes
// no network requests; the runtime controller fetches only after the user has
// configured a source.

import { profileStorageKey } from './profile-storage-key.js';

export const AUTO_IMPORT_FEED_STORAGE_SUFFIX = 'autoImportFeedV1';
/**
 * Largest feed accepted. A larger document is rejected with a clear status
 * instead of silently hiding its later entries.
 */
export const AUTO_IMPORT_FEED_MAX_ENTRIES = 5000;
/**
 * Bounded handled-id history. It is at least as large as the feed cap, and ids
 * still listed by the feed are evicted last, so a handled report that is still
 * in the feed is never offered again.
 */
export const AUTO_IMPORT_FEED_MAX_DONE_IDS = AUTO_IMPORT_FEED_MAX_ENTRIES;
/** New reports handed to one review batch; the rest are offered on later checks. */
export const AUTO_IMPORT_FEED_MAX_PER_CHECK = 50;
/**
 * Request header that marks a same-origin auto-import feed or report fetch.
 * The service worker passes only requests carrying this exact header straight
 * to the network, so live reports are never answered from or written to the
 * offline app cache. Keep in sync with service-worker-runtime.ts.
 */
export const AUTO_IMPORT_FRESH_HEADER = 'X-GetBased-Fresh';
export const AUTO_IMPORT_FRESH_VALUE = 'auto-import';
const MAX_ID_LENGTH = 200;

export interface AutoImportFeedItem {
  id: string;
  title: string;
  url: string;
  created: string | null;
}

export interface AutoImportFeedConfig {
  url: string;
  doneIds: string[];
  lastCheckedAt: string | null;
  lastStatus: string | null;
}

const EMPTY_CONFIG: AutoImportFeedConfig = { url: '', doneIds: [], lastCheckedAt: null, lastStatus: null };

export class AutoImportFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoImportFeedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Feed and report addresses must be HTTPS, or plain HTTP only for a trusted
 * origin (the app's own origin, the feed's origin) or loopback. No credentials
 * are attached to cross-origin requests.
 */
function isAllowedUrl(url: URL, trustedOrigins: readonly string[]): boolean {
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return trustedOrigins.includes(url.origin) || LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** URL policy for an address that was fetched or reached through a redirect. */
export function isAllowedAutoImportUrl(href: string, trustedOrigins: readonly string[]): boolean {
  try { return isAllowedUrl(new URL(href), trustedOrigins); } catch (_) { return false; }
}

function originOf(href: string): string | null {
  try { return new URL(href).origin; } catch (_) { return null; }
}

/**
 * Normalize a user-entered feed address. Relative paths resolve against the
 * app origin so a same-origin feed can be entered as `/path/feed.json`.
 * Returns '' for an empty input and null for an unusable address.
 */
export function normalizeAutoImportFeedUrl(input: unknown, baseUrl: string): string | null {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  let url: URL;
  try { url = new URL(raw, baseUrl); } catch (_) { return null; }
  const appOrigin = originOf(baseUrl);
  if (!isAllowedUrl(url, appOrigin ? [appOrigin] : [])) return null;
  return url.href;
}

function itemId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return id && id.length <= MAX_ID_LENGTH ? id : null;
}

function itemCreated(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * Parse a feed document. Item URLs resolve against the feed URL. Malformed
 * items are dropped; a document without an `items` array, or with more than
 * AUTO_IMPORT_FEED_MAX_ENTRIES entries, is rejected. Every entry is parsed so
 * handled ids can be filtered before any per-check limit is applied.
 * Items are returned oldest first so imports land in chronological order.
 */
export function parseAutoImportFeed(doc: unknown, feedUrl: string): AutoImportFeedItem[] {
  if (!isRecord(doc) || !Array.isArray(doc.items)) {
    throw new AutoImportFeedError('Feed is not in the expected format');
  }
  if (doc.items.length > AUTO_IMPORT_FEED_MAX_ENTRIES) {
    throw new AutoImportFeedError(`Feed lists more than ${AUTO_IMPORT_FEED_MAX_ENTRIES} reports; publish only recent ones`);
  }
  const feedOrigin = originOf(feedUrl);
  const trusted = feedOrigin ? [feedOrigin] : [];
  const seen = new Set<string>();
  const items: AutoImportFeedItem[] = [];
  for (const entry of doc.items) {
    if (!isRecord(entry)) continue;
    const id = itemId(entry.id);
    if (!id || seen.has(id) || typeof entry.url !== 'string' || !entry.url.trim()) continue;
    let url: URL;
    try { url = new URL(entry.url.trim(), feedUrl); } catch (_) { continue; }
    if (!isAllowedUrl(url, trusted)) continue;
    seen.add(id);
    const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : `Report ${id}`;
    items.push({ id, title, url: url.href, created: itemCreated(entry.created) });
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const at = a.item.created ? Date.parse(a.item.created) : Number.POSITIVE_INFINITY;
      const bt = b.item.created ? Date.parse(b.item.created) : Number.POSITIVE_INFINITY;
      return at === bt ? a.index - b.index : at - bt;
    })
    .map(({ item }) => item);
}

/** Items whose ids have not been imported or dismissed yet. */
export function selectNewAutoImportItems(items: readonly AutoImportFeedItem[], doneIds: Iterable<string>): AutoImportFeedItem[] {
  const done = new Set(doneIds);
  return items.filter(item => !done.has(item.id));
}

/** A safe download name for the review flow, always ending in `.pdf`. */
export function autoImportFileName(item: Pick<AutoImportFeedItem, 'id' | 'title'>): string {
  const base = item.title
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${base || `report-${item.id}`}.pdf`;
}

/** True when the bytes start with the PDF signature. */
export function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function storageKey(profileId: string): string {
  return profileStorageKey(profileId, AUTO_IMPORT_FEED_STORAGE_SUFFIX);
}

function getStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch (_) { return null; }
}

export function readAutoImportFeedConfig(profileId: string): AutoImportFeedConfig {
  const storage = getStorage();
  if (!storage) return { ...EMPTY_CONFIG, doneIds: [] };
  let parsed: unknown = null;
  try { parsed = JSON.parse(storage.getItem(storageKey(profileId)) || 'null'); } catch (_) { parsed = null; }
  if (!isRecord(parsed)) return { ...EMPTY_CONFIG, doneIds: [] };
  return {
    url: typeof parsed.url === 'string' ? parsed.url : '',
    doneIds: Array.isArray(parsed.doneIds) ? parsed.doneIds.filter((id): id is string => typeof id === 'string') : [],
    lastCheckedAt: typeof parsed.lastCheckedAt === 'string' ? parsed.lastCheckedAt : null,
    lastStatus: typeof parsed.lastStatus === 'string' ? parsed.lastStatus : null,
  };
}

function writeAutoImportFeedConfig(profileId: string, config: AutoImportFeedConfig): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    if (!config.url && !config.doneIds.length) storage.removeItem(storageKey(profileId));
    else storage.setItem(storageKey(profileId), JSON.stringify(config));
    return true;
  } catch (_) {
    return false;
  }
}

export function isAutoImportFeedConfigured(profileId: string): boolean {
  return Boolean(readAutoImportFeedConfig(profileId).url);
}

/** Save (or clear, with '') the feed address. Imported history is kept. */
export function saveAutoImportFeedUrl(profileId: string, url: string): boolean {
  const current = readAutoImportFeedConfig(profileId);
  const changed = current.url !== url;
  return writeAutoImportFeedConfig(profileId, {
    ...current,
    url,
    lastCheckedAt: changed ? null : current.lastCheckedAt,
    lastStatus: changed ? null : current.lastStatus,
  });
}

/**
 * Record handled ids. When the history is full, ids no longer listed by the
 * feed (`listedIds`, the latest feed's ids) are evicted first, oldest first.
 */
export function markAutoImportItemsDone(profileId: string, ids: readonly string[], listedIds?: Iterable<string>): boolean {
  if (!ids.length) return true;
  const current = readAutoImportFeedConfig(profileId);
  const added = new Set(ids);
  let merged = current.doneIds.filter(id => !added.has(id)).concat([...added]);
  let excess = merged.length - AUTO_IMPORT_FEED_MAX_DONE_IDS;
  if (excess > 0 && listedIds) {
    const listed = new Set(listedIds);
    merged = merged.filter(id => {
      if (excess > 0 && !listed.has(id) && !added.has(id)) { excess--; return false; }
      return true;
    });
  }
  return writeAutoImportFeedConfig(profileId, { ...current, doneIds: merged.slice(-AUTO_IMPORT_FEED_MAX_DONE_IDS) });
}

export function clearAutoImportHistory(profileId: string): boolean {
  const current = readAutoImportFeedConfig(profileId);
  return writeAutoImportFeedConfig(profileId, { ...current, doneIds: [] });
}

export function recordAutoImportCheck(profileId: string, status: string, at: Date = new Date()): boolean {
  const current = readAutoImportFeedConfig(profileId);
  if (!current.url) return false;
  return writeAutoImportFeedConfig(profileId, { ...current, lastCheckedAt: at.toISOString(), lastStatus: status });
}
