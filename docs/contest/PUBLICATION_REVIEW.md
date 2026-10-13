# Publication preparation

The repository remains private. Changing visibility and submitting the entry are
owner steps; nothing in this preparation publishes Source.

- MIT LICENSE was already tracked; the owner confirmed retaining MIT.
- SiteKit's MIT notice and Departure Mono's OFL are retained. See
  [third-party notices](../../THIRD_PARTY_NOTICES.md).
- `.source/instance.json` and `.source/audit.jsonl` were tracked initialization
  records. They were removed from the current Git index, not wiped from local
  storage or rewritten out of history. Their old history still exists.
- Demo data/password files are ignored and excluded from Docker's build context.
- A bounded pattern scan with Source's own `scanSecrets` examined 225 reachable
  commits and 943 unique blobs before this preparation was committed. It flagged
  generic credential literals in test fixtures and historical test patches;
  inspected current contexts are fixture login/redaction cases. No live credential
  was confirmed. This is not a comprehensive secret or private-data audit.
- Before public visibility, the owner should review historical metadata, internal
  notes/patches and ownership of all content. Pattern scanning cannot decide what
  business information should be public. No history rewrite was performed.
- No GitHub releases were returned by the releases API at review time. Package
  version 0.1.0 does not mean a release has been published.

After approval: merge/select the exact entry commit, publish the repository,
clone anonymously into a clean directory, follow RUNBOOK.md, and use that same
commit in the final video and entry form.

## Follow-up review — 2026-10-13

At `5e7efbc02b6fdd55ae682727340171758a7fed80`, the reproducible command
`node scripts/publication/audit.js` inventoried 233 locally reachable commits
and 978 unique blobs. It reports object IDs, paths and categories, never matched
credential values. In addition to Source's credential patterns it inventories
home paths, email addresses and Artifacts token patterns. Fetch all intended
publication refs before repeating it; unreachable objects, hosting-provider
attachments, issues and pull-request conversations are outside its scope.

The current tree still contained 24 `.loop-engineering/` run artifacts, including
historical patches, failed gate logs and a memory-request note with local home
paths. They are now untracked and excluded from Git and Docker packaging. Local
copies and historical commits remain intact. These are internal execution
records, not product documentation; their removal does not change runtime code.
Historical `.source/` initialization records also remain in history.

The scan found no Artifacts token pattern. Credential-pattern hits are confined
to test fixtures and archived test patches; no live credential was confirmed.
Email matches occur in license/security contact information and fixture Git
identities. License attribution must remain. The owner must decide whether the
published security contact and historical author identities are appropriate.
No history rewrite or visibility change was performed.

Publication handoff: inspect the historical internal archive and Git author
metadata before approving public exposure. If those records are unsuitable,
choose a reviewed history rewrite or a clean publication repository; deleting
files at HEAD does not remove historical disclosure. This bounded review is not
an independent security assessment or a guarantee that no private data exists.
