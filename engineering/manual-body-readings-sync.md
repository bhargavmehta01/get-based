# Manual body reading Sync

Explicitly entered weight, systolic/diastolic blood pressure and pulse readings
use the encrypted profile Sync surface `manualBodyReadings`. Raw vendor and
file-imported wearable histories stay device-local. Connection credentials and
restricted provider data do not enter this map.

Each key is `<field>.<YYYY-MM-DD>`, so same-day weight, BP and pulse compose rather
than replacing a date-wide row. Values carry `value` and `updatedAt`; the known
fields are the four manual metrics plus the existing shared date-level tags and
note. Values must have their expected primitive type and a real calendar date.
Unknown incoming fields are retained in profile data but are not written into
the local Reading store. Updates preserve opaque existing row fields.

The Reading store remains the display source of truth. Explicit log/edit actions
write the narrow mirror alongside the existing guarded profile mutation. Pull
reconciliation applies validated fields to source `manual`, honors per-metric
and delete-all intent, and establishes the local manual connection when needed.
A newer local field edit cannot be replaced by an older blob or row overlay.
User deletions clear values and private field metadata, retain their clocks and
use the existing `manualMetricTombstones` protocol; an explicit re-add clears its
delete marker. An empty local store never produces deletion intent.

Ordinary page startup and profile switching share lazy catch-up. A one-time,
add-only upgrade copies pre-existing manual rows after applying incoming values.
It never scans vendor histories, overwrites an existing mirror key, infers a
remote deletion or marks an empty/locked read as successfully upgraded. The
completion flag follows successful profile persistence. The upgrade commits only
if its canonical stored snapshot still matches inside the profile write lock; a
concurrent edit or deletion triggers a bounded retry from current data. Profile/data/Sync-owner
changes retire asynchronous reconciliation work. The module is requested only
when manual history or a manual mirror exists.

Single-profile portable exports include the mirror even when a profile has no
lab entries. Both JSON restore paths retain the map; the normal startup/profile
catch-up materializes its validated records. Raw vendor histories remain outside
this portable profile surface.

Verification combines [real store and row-codec tests](../tests/manual-body-readings-sync.test.ts),
[ownership/failure checks](../tests/manual-body-readings-ownership.test.ts),
[existing deletion tests](../tests/manual-heart-rate-deletion.test.ts),
[existing manual browser workflows](../tests/playwright/manual-profile-persistence.spec.ts)
and [ordinary-startup/detail acceptance](../tests/playwright/manual-readings-sync.spec.ts).
These do not establish physical device, vendor API or external-relay acceptance.
