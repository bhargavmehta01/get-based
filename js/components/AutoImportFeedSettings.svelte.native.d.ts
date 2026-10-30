import type { Component } from 'svelte';
import type { AutoImportFeedSnapshot, SettingsRecordsView } from '../settings-records-contract.js';
declare const AutoImportFeedSettings: Component<{ initial: AutoImportFeedSnapshot }, SettingsRecordsView<AutoImportFeedSnapshot>>;
export default AutoImportFeedSettings;
export { mount, unmount, flushSync } from 'svelte';
