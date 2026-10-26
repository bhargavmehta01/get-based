<script lang="ts">
  import { untrack } from 'svelte';
  import type { AutoImportFeedSnapshot } from '../settings-records-contract.js';
  import { RECORD_PRIMARY, RECORD_SECONDARY, RECORD_EDIT } from '../settings-records-classes.js';
  let { initial }: { initial: AutoImportFeedSnapshot } = $props();
  let snapshot = $state(untrack(() => initial));
  export function refresh(next: AutoImportFeedSnapshot): void { snapshot = next; }
</script>

<div data-auto-import-feed-settings>
  <div class="gb:records:text-[12px] gb:records:text-secondary gb:records:leading-[1.5] gb:records:mb-2.5">Optionally check a JSON feed of PDF lab reports (for example from a self-hosted document manager) when the app opens. New reports open in the normal import review; nothing is saved until you confirm. The feed address receives a request on each check. Off when empty.</div>
  <label class="gb:records:block gb:records:text-[12px] gb:records:text-secondary gb:records:mb-1" for="auto-import-feed-url">Feed URL</label>
  <div class="gb:records:flex gb:records:gap-2 gb:records:items-center gb:records:flex-wrap">
    <input id="auto-import-feed-url" type="url" inputmode="url" class="gb:records:flex-1 gb:records:min-w-[220px] gb:records:text-[13px] gb:records:px-2.5 gb:records:py-2 gb:records:rounded-control gb:records:border gb:records:border-line gb:records:bg-surface gb:records:text-ink gb:records:[font-family:inherit] gb:records:[@media(pointer:coarse)]:min-h-11" placeholder="https://example.org/feed.json" autocomplete="off" spellcheck="false" value={snapshot.url}>
    <button type="button" class={RECORD_PRIMARY} data-settings-action="save-auto-import-feed">Save</button>
    <button type="button" class={RECORD_SECONDARY} data-settings-action="check-auto-import-feed" disabled={!snapshot.configured}>Check now</button>
  </div>
  <div class="gb:records:flex gb:records:items-center gb:records:gap-2 gb:records:mt-2 gb:records:flex-wrap">
    <span class="auto-import-feed-status gb:records:text-[12px] gb:records:text-secondary">Status: {snapshot.status}</span>
    {#if snapshot.doneCount}<button type="button" class={RECORD_EDIT} data-settings-action="clear-auto-import-history" title="Offer previously imported or skipped feed reports again">Forget {snapshot.doneCount} handled report{snapshot.doneCount === 1 ? '' : 's'}</button>{/if}
  </div>
</div>
