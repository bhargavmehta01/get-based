<script lang="ts">
  import { untrack } from 'svelte';
  import type { AutoImportFeedSnapshot } from '../settings-records-contract.js';
  import { RECORD_PRIMARY, RECORD_SECONDARY, RECORD_EDIT, FEED_DESCRIPTION, FEED_INPUT, FEED_BUTTON, FEED_SUMMARY } from '../settings-records-classes.js';
  let { initial }: { initial: AutoImportFeedSnapshot } = $props();
  let snapshot = $state(untrack(() => initial));
  let draftUrl = $state(untrack(() => initial.url));
  const changed = $derived(draftUrl.trim() !== snapshot.url);
  export function refresh(next: AutoImportFeedSnapshot): void {
    if (next.profileId !== snapshot.profileId || next.url !== snapshot.url) draftUrl = next.url;
    snapshot = next;
  }
</script>

<div data-auto-import-feed-settings data-auto-import-profile={snapshot.profileId} class="gb:records:min-w-0">
  <p id="auto-import-feed-description" class="{FEED_DESCRIPTION} gb:records:m-0 gb:records:mb-3">Find new PDFs in your document archive, then review each report before importing.</p>

  <label class="gb:records:block gb:records:text-[12px] gb:records:font-medium gb:records:text-secondary gb:records:mb-1.5" for="auto-import-feed-url">Report feed address</label>
  <input id="auto-import-feed-url" type="url" inputmode="url" class={FEED_INPUT} placeholder="https://your-archive.example/labs/feed.json" autocomplete="off" spellcheck="false" aria-describedby="auto-import-feed-description auto-import-feed-help" bind:value={draftUrl}>
  <p id="auto-import-feed-help" class="{FEED_DESCRIPTION} gb:records:m-0 gb:records:mt-1.5">{snapshot.configured ? 'Checked when getbased opens, or whenever you check for reports.' : 'Optional. Save an address to enable checks for this profile.'}</p>

  <div class="gb:records:flex gb:records:items-center gb:records:gap-2 gb:records:flex-wrap gb:records:mt-3">
    <button type="button" class="{RECORD_PRIMARY} {FEED_BUTTON}" data-settings-action="save-auto-import-feed" disabled={!draftUrl.trim() || !changed}>{snapshot.configured ? 'Save changes' : 'Save source'}</button>
    <button type="button" class="{RECORD_SECONDARY} {FEED_BUTTON}" data-settings-action="check-auto-import-feed" disabled={!snapshot.configured || changed}>Check for reports</button>
    {#if snapshot.configured}<button type="button" class="{RECORD_EDIT} {FEED_BUTTON}" data-settings-action="disconnect-auto-import-feed">Disconnect</button>{/if}
  </div>

  <div class="gb:records:flex gb:records:items-baseline gb:records:gap-2 gb:records:flex-wrap gb:records:mt-3" role="status" aria-live="polite">
    <span class="auto-import-feed-status gb:records:text-[12px] gb:records:font-medium gb:records:text-secondary">{snapshot.configured ? snapshot.status : 'Off'}</span>
    {#if snapshot.doneCount}<span class="gb:records:text-[12px] gb:records:text-secondary">· {snapshot.doneCount} report{snapshot.doneCount === 1 ? '' : 's'} imported or skipped</span>{/if}
    {#if changed && snapshot.configured}<span class="gb:records:text-[12px] gb:records:text-secondary">· Save your changes before checking</span>{/if}
  </div>

  <details class="gb:records:mt-3">
    <summary class={FEED_SUMMARY}>Source requirements</summary>
    <div class="{FEED_DESCRIPTION} gb:records:mt-2 gb:records:grid gb:records:gap-2 gb:records:min-w-0">
      <p class="gb:records:m-0">Use a JSON feed from your document manager. It lists each PDF with a stable report ID and a download address. Your archive may need a feed adapter.</p>
      <code class="gb:records:block gb:records:rounded-control gb:records:border gb:records:border-line gb:records:bg-secondary-surface gb:records:px-3 gb:records:py-2 gb:records:font-mono gb:records:text-[11px] gb:records:text-ink gb:records:whitespace-pre-wrap gb:records:break-all">{'{"items":[{"id":"report-1","url":"/reports/1.pdf"}]}'}</code>
      <p class="gb:records:m-0">The source receives a request on each check. Reports use your usual AI settings and privacy review.</p>
    </div>
  </details>

  {#if snapshot.doneCount}
    <details class="gb:records:mt-2">
      <summary class={FEED_SUMMARY}>Report history</summary>
      <div class="{FEED_DESCRIPTION} gb:records:mt-2">
        <p class="gb:records:m-0 gb:records:mb-1">Previously imported or skipped reports are left out of future checks. Reset this list to review them again.</p>
        <button type="button" class="{RECORD_EDIT} {FEED_BUTTON}" data-settings-action="clear-auto-import-history">Reset report history</button>
      </div>
    </details>
  {/if}
</div>
