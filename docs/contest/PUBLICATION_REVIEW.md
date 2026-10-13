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
