#!/usr/bin/env node
// Run after npm run typescript:build. This creates only ignored local fixtures.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startAutoImportSourceFixture } from '../tests/helpers/auto-import-source-fixture.js';

export function sandboxLauncherHtml(appOrigin: string, sourceOrigin: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Synthetic report sandbox</title>
<body><main><h1>Synthetic report sandbox</h1><p>This separate localhost origin uses made-up lab PDFs and a deterministic AI fixture. No Paperless, model, API key, or paid inference is needed.</p>
<p>Preparing the sandbox configures its default profile with a local report source and test AI endpoint. Your app on port 8000 stays separate. Normal legal and privacy notices remain in place.</p>
<button id="prepare">Prepare sandbox and open getbased</button><p id="status" role="status"></p>
<h2>Try the flow</h2><ol><li>Open Settings → Data → Lab report source and choose Check for reports (startup may offer it first).</li><li>Choose Later, then check again and choose Review now.</li><li>Review the privacy text, choose Send to AI, then inspect the two synthetic marker results.</li><li>Choose Import 2 Markers or Skip. Check again: the handled report should stay handled after reloading.</li></ol>
<p>Other feed addresses (save in Lab report source):</p><ul><li>Two reports: ${sourceOrigin}/feed.json?scenario=two</li><li>Temporary failure, then retry: ${sourceOrigin}/feed.json?scenario=retry</li><li>Invalid PDF: ${sourceOrigin}/feed.json?scenario=invalid</li><li>Empty feed: ${sourceOrigin}/feed.json?scenario=empty</li></ul>
<p>Reset report history to offer handled reports again. Saving a different feed address starts a new handled-ID history. All PDFs are marked SYNTHETIC TEST DATA. This verifies getbased's flow, not Paperless authentication or AI extraction quality.</p></main>
<script type="module">
const status = document.querySelector('#status');
document.querySelector('#prepare').onclick = async () => {
  try {
    if (location.origin !== '${appOrigin}') throw new Error('Open the dedicated sandbox on port 8002.');
    const marker = 'getbased-synthetic-feed-sandbox';
    if (!localStorage.getItem(marker) && Object.keys(localStorage).some(key => key.startsWith('labcharts-'))) throw new Error('This origin already contains app settings. Use a fresh browser profile; existing data was left unchanged.');
    localStorage.setItem(marker, '1');
    const { encryptedSetCredentialItem } = await import('/js/crypto.js');
    (await import('/js/api-provider-storage-runtime.js')).configureApiProviderStorageRuntimeDeps({ encryptedSetItem: encryptedSetCredentialItem });
    const api = await import('/js/api-provider-storage.js');
    await api.saveCustomApiConnection('${sourceOrigin}/v1', 'synthetic-fixture-only');
    api.setCustomApiModel('synthetic-lab-fixture'); api.setAIProvider('custom');
    const feed = await import('/js/auto-import-feed.js');
    if (!feed.saveAutoImportFeedUrl('default', '${sourceOrigin}/feed.json')) throw new Error('Could not save sandbox source.');
    for (const key of ['emptyTour', 'tour']) localStorage.setItem('labcharts-default-' + key, 'completed');
    location.assign('/app?dev=synthetic-feed-sandbox');
  } catch (error) { status.textContent = error.message; }
};
</script></body></html>`;
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const appOrigin = 'http://127.0.0.1:8002';
  const fixture = await startAutoImportSourceFixture({ port: 8003, allowedOrigins: [appOrigin, 'http://127.0.0.1:8000'] });
  const notes = new URL('../.local-notes/auto-import-sandbox/', import.meta.url);
  await mkdir(notes, { recursive: true });
  await writeFile(new URL('start.html', notes), sandboxLauncherHtml(appOrigin, fixture.origin));

const child = spawn(process.execPath, ['dev-server.js', '8002'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', OPEN_BROWSER: '0', GETBASED_AUTO_AGENT_HOST: '0' }, stdio: 'inherit' });
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  await fixture.close();
  process.exitCode = code;
}
child.once('error', error => { console.error(error.message); void stop(1); });
child.once('exit', code => { void stop(code ?? 1); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop(); });
console.log(`\nSynthetic sandbox: ${appOrigin}/.local-notes/auto-import-sandbox/start.html\nFeed and fake AI: ${fixture.origin}\nStop with Ctrl+C. Existing app on port 8000 is unchanged.\n`);

}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  await main();
}
