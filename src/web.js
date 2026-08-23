// Source — minimal human-facing HTML views.
//
// The frontend is not the primary innovation. These views are enough for a
// maintainer to understand what happened: org, project, work, change, evidence.
// All content is HTML-escaped (repo content is untrusted data).

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.5}
h1,h2{border-bottom:1px solid #eee;padding-bottom:.25rem}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.4rem;text-align:left}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:3px;font-size:.8rem;background:#eee}
.ok{background:#d4edda;color:#155724}.missing{background:#f8d7da;color:#721c24}
pre{background:#f6f8fa;padding:.75rem;overflow:auto}</style></head>
<body>${body}</body></html>`;
}

// Instance index: list organizations (the tenant boundary).
export function renderOrgIndex(src) {
  const orgs = src.listOrgs();
  const rows = orgs
    .map((o) => `<tr><td><a href="/o/${esc(o.id)}">${esc(o.name)}</a></td><td>${esc(o.slug)}</td><td>${esc(o.visibility)}</td></tr>`)
    .join('');
  return page('Source', `<h1>Source</h1><h2>Organizations</h2><table><tr><th>Name</th><th>Slug</th><th>Visibility</th></tr>${rows || '<tr><td colspan=3>none</td></tr>'}</table>`);
}

// Organization index: list the org's projects.
export function renderIndex(src, orgId) {
  const org = src.getOrg(orgId);
  const projects = src.listProjects(orgId);
  const rows = projects
    .map((p) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(p.id)}">${esc(p.name)}</a></td><td>${esc(p.slug)}</td><td>${esc(p.visibility)}</td></tr>`)
    .join('');
  return page(org ? org.name : 'Source', `<h1>${esc(org?.name ?? 'Source')}</h1><h2>Projects</h2><table><tr><th>Name</th><th>Slug</th><th>Visibility</th></tr>${rows || '<tr><td colspan=3>none</td></tr>'}</table>`);
}

export function renderProject(src, orgId, projectId) {
  const p = src.getProject(orgId, projectId);
  if (!p) return page('Not found', '<h1>Not found</h1>');
  const work = src.listWork(orgId, projectId);
  const changes = src.listChanges(orgId, projectId);
  const workRows = work
    .map((w) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(projectId)}/w/${esc(w.id)}">${esc(w.id)}</a></td><td>${esc(w.intent)}</td><td><span class="badge">${esc(w.status)}</span></td></tr>`)
    .join('');
  const changeRows = changes
    .map((c) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(c.id)}">${esc(c.id)}</a></td><td>${esc(c.workId)}</td><td><span class="badge">${esc(c.decisionState)}</span></td></tr>`)
    .join('');
  return page(
    p.name,
    `<h1>${esc(p.name)}</h1><p>${esc(p.description)}</p>
<h2>Repositories</h2><ul>${p.repositories.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Work</h2><table><tr><th>ID</th><th>Intent</th><th>Status</th></tr>${workRows || '<tr><td colspan=3>none</td></tr>'}</table>
<h2>Changes</h2><table><tr><th>ID</th><th>Work</th><th>Decision</th></tr>${changeRows || '<tr><td colspan=3>none</td></tr>'}</table>`,
  );
}

export function renderWork(src, orgId, projectId, workId) {
  const w = src.getWork(orgId, projectId, workId);
  if (!w) return page('Not found', '<h1>Not found</h1>');
  return page(
    `Work ${w.id}`,
    `<h1>Work ${esc(w.id)}</h1>
<p><strong>Intent:</strong> ${esc(w.intent)}</p>
<p><strong>Status:</strong> <span class="badge">${esc(w.status)}</span> · <strong>Assignee:</strong> ${esc(w.assignee)}</p>
<h2>Requirements</h2><ul>${w.requirements.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Acceptance conditions</h2><ul>${w.acceptanceConditions.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Sessions</h2><ul>${w.sessions.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Changes</h2><ul>${w.changes.map((c) => `<li><a href="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(c)}">${esc(c)}</a></li>`).join('') || '<li>none</li>'}</ul>`,
  );
}

export function renderChange(src, orgId, projectId, changeId) {
  const c = src.getChange(orgId, projectId, changeId);
  if (!c) return page('Not found', '<h1>Not found</h1>');
  const work = src.getWork(orgId, projectId, c.workId);
  const evaluation = src.evaluateChange({ orgId, projectId, changeId });
  const evidence = c.evidence.map((id) => src.getEvidence(orgId, projectId, id)).filter(Boolean);
  const decisions = (c.decisions || []).map((id) => src.getDecision(orgId, projectId, id)).filter(Boolean);

  const evidenceRows = evidence
    .map((e) => `<tr><td>${esc(e.id)}</td><td>${esc(e.type)}</td><td>${esc(e.claim)}</td><td><span class="badge ${e.validity === 'valid' ? 'ok' : 'missing'}">${esc(e.validity)}</span></td></tr>`)
    .join('');

  const interpretation = evaluation.interpretation
    .map((l) => `<li>${esc(l)}</li>`)
    .join('');

  const decisionRows = decisions
    .map((d) => `<tr><td>${esc(d.id)}</td><td><span class="badge">${esc(d.decision)}</span></td><td>${esc(d.decider)}</td><td>${esc(d.reasoning)}</td></tr>`)
    .join('');

  return page(
    `Change ${c.id}`,
    `<h1>Change ${esc(c.id)}</h1>
<h2>What was requested</h2><p>${esc(work?.intent ?? '')}</p>
<h2>What changed</h2><p>base <code>${esc(c.baseCommit)}</code> → head <code>${esc(c.headCommit)}</code></p>
<h2>What proves it</h2><table><tr><th>ID</th><th>Type</th><th>Claim</th><th>Validity</th></tr>${evidenceRows || '<tr><td colspan=4>none</td></tr>'}</table>
<h2>What requires attention</h2><ul>${interpretation}</ul>
<h2>Decision</h2><table><tr><th>ID</th><th>Decision</th><th>Decider</th><th>Reasoning</th></tr>${decisionRows || '<tr><td colspan=4>none</td></tr>'}</table>
<h2>Technical details</h2><pre>${esc(JSON.stringify({ baseCommit: c.baseCommit, headCommit: c.headCommit, reviewState: c.reviewState, decisionState: c.decisionState }, null, 2))}</pre>`,
  );
}

// Async variants keep the human-facing fallback UI from invoking the legacy
// synchronous Postgres/psql compatibility path on an API event-loop thread.
export async function renderOrgIndexAsync(src) {
  const orgs = await src.listOrgsAsync();
  const rows = orgs.map((o) => `<tr><td><a href="/o/${esc(o.id)}">${esc(o.name)}</a></td><td>${esc(o.slug)}</td><td>${esc(o.visibility)}</td></tr>`).join('');
  return page('Source', `<h1>Source</h1><h2>Organizations</h2><table><tr><th>Name</th><th>Slug</th><th>Visibility</th></tr>${rows || '<tr><td colspan=3>none</td></tr>'}</table>`);
}

export async function renderIndexAsync(src, orgId) {
  const org = await src.getOrgAsync(orgId);
  const projects = await src.listProjectsAsync(orgId, { limit: 1_000 });
  const rows = projects.map((p) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(p.id)}">${esc(p.name)}</a></td><td>${esc(p.slug)}</td><td>${esc(p.visibility)}</td></tr>`).join('');
  return page(org ? org.name : 'Source', `<h1>${esc(org?.name ?? 'Source')}</h1><h2>Projects</h2><table><tr><th>Name</th><th>Slug</th><th>Visibility</th></tr>${rows || '<tr><td colspan=3>none</td></tr>'}</table>`);
}

export async function renderProjectAsync(src, orgId, projectId) {
  const p = await src.getProjectAsync(orgId, projectId);
  if (!p) return page('Not found', '<h1>Not found</h1>');
  const [work, changes] = await Promise.all([
    src.listWorkAsync(orgId, projectId, { limit: 1_000 }),
    src.listChangesAsync(orgId, projectId, { limit: 1_000 }),
  ]);
  const workRows = work.map((w) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(projectId)}/w/${esc(w.id)}">${esc(w.id)}</a></td><td>${esc(w.intent)}</td><td><span class="badge">${esc(w.status)}</span></td></tr>`).join('');
  const changeRows = changes.map((c) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(c.id)}">${esc(c.id)}</a></td><td>${esc(c.workId)}</td><td><span class="badge">${esc(c.decisionState)}</span></td></tr>`).join('');
  return page(p.name, `<h1>${esc(p.name)}</h1><p>${esc(p.description)}</p>
<h2>Repositories</h2><ul>${p.repositories.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Work</h2><table><tr><th>ID</th><th>Intent</th><th>Status</th></tr>${workRows || '<tr><td colspan=3>none</td></tr>'}</table>
<h2>Changes</h2><table><tr><th>ID</th><th>Work</th><th>Decision</th></tr>${changeRows || '<tr><td colspan=3>none</td></tr>'}</table>`);
}

export async function renderWorkAsync(src, orgId, projectId, workId) {
  const w = await src.getWorkAsync(orgId, projectId, workId);
  if (!w) return page('Not found', '<h1>Not found</h1>');
  return page(`Work ${w.id}`, `<h1>Work ${esc(w.id)}</h1>
<p><strong>Intent:</strong> ${esc(w.intent)}</p>
<p><strong>Status:</strong> <span class="badge">${esc(w.status)}</span> · <strong>Assignee:</strong> ${esc(w.assignee)}</p>
<h2>Requirements</h2><ul>${w.requirements.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Acceptance conditions</h2><ul>${w.acceptanceConditions.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Sessions</h2><ul>${w.sessions.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Changes</h2><ul>${w.changes.map((c) => `<li><a href="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(c)}">${esc(c)}</a></li>`).join('') || '<li>none</li>'}</ul>`);
}

export async function renderChangeAsync(src, orgId, projectId, changeId) {
  const c = await src.getChangeAsync(orgId, projectId, changeId);
  if (!c) return page('Not found', '<h1>Not found</h1>');
  const [work, evaluation, evidence, decisions] = await Promise.all([
    src.getWorkAsync(orgId, projectId, c.workId),
    src.evaluateChangeAsync({ orgId, projectId, changeId }),
    src.getEvidenceManyAsync(orgId, projectId, c.evidence),
    src.getDecisionManyAsync(orgId, projectId, c.decisions || []),
  ]);
  const evidenceRows = evidence.map((e) => `<tr><td>${esc(e.id)}</td><td>${esc(e.type)}</td><td>${esc(e.claim)}</td><td><span class="badge ${e.validity === 'valid' ? 'ok' : 'missing'}">${esc(e.validity)}</span></td></tr>`).join('');
  const interpretation = evaluation.interpretation.map((l) => `<li>${esc(l)}</li>`).join('');
  const decisionRows = decisions.map((d) => `<tr><td>${esc(d.id)}</td><td><span class="badge">${esc(d.decision)}</span></td><td>${esc(d.decider)}</td><td>${esc(d.reasoning)}</td></tr>`).join('');
  return page(`Change ${c.id}`, `<h1>Change ${esc(c.id)}</h1>
<h2>What was requested</h2><p>${esc(work?.intent ?? '')}</p>
<h2>What changed</h2><p>base <code>${esc(c.baseCommit)}</code> → head <code>${esc(c.headCommit)}</code></p>
<h2>What proves it</h2><table><tr><th>ID</th><th>Type</th><th>Claim</th><th>Validity</th></tr>${evidenceRows || '<tr><td colspan=4>none</td></tr>'}</table>
<h2>What requires attention</h2><ul>${interpretation}</ul>
<h2>Decision</h2><table><tr><th>ID</th><th>Decision</th><th>Decider</th><th>Reasoning</th></tr>${decisionRows || '<tr><td colspan=4>none</td></tr>'}</table>
<h2>Technical details</h2><pre>${esc(JSON.stringify({ baseCommit: c.baseCommit, headCommit: c.headCommit, reviewState: c.reviewState, decisionState: c.decisionState }, null, 2))}</pre>`);
}

export function renderLogin(opts = {}) {
  const error = opts.error ? `<p style="color:#b00020">Error: ${esc(opts.error)}</p>` : '';
  return page(
    'Source Login',
    `<h1>Sign in with a human principal</h1>
${error}
<form method="POST" action="/login">
  <label>Principal ID <input name="principalId" placeholder="human principal id" /></label><br/><br/>
  <label>Password <input type="password" name="password" autocomplete="current-password" /></label><br/><br/>
  <label>Org ID <input name="orgId" required /></label><br/><br/>
  <label>Project ID <input name="projectId" required /></label><br/><br/>
  <button type="submit">Sign in</button>
</form>`,
  );
}
