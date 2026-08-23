// Source — minimal human-facing HTML views.
//
// The frontend is not the primary innovation. These views are enough for a
// maintainer to understand what happened: org, project, work, change, evidence.
// All content is HTML-escaped (repo content is untrusted data).

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title, body, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>:root{color-scheme:light}body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1100px;margin:0 auto;padding:2rem 1.25rem;line-height:1.5;color:#1f2328;background:#fff}
h1,h2{border-bottom:1px solid #eee;padding-bottom:.25rem}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.4rem;text-align:left}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:3px;font-size:.8rem;background:#eee}
.ok{background:#d4edda;color:#155724}.missing{background:#f8d7da;color:#721c24}
pre{background:#f6f8fa;padding:.75rem;overflow:auto}.auth-shell{min-height:calc(100vh - 4rem);display:grid;place-items:center}.auth-card{width:min(100%,560px);border:1px solid #d0d7de;border-radius:14px;padding:2rem;box-shadow:0 8px 30px #1f232812}.auth-card h1{margin-top:0}.auth-card .brand{font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#57606a;font-size:.8rem}.auth-card form{margin:1.5rem 0 0}.auth-card label{display:block;margin:1rem 0;font-weight:600}.auth-card input:not([type=checkbox]){display:block;width:100%;box-sizing:border-box;margin-top:.35rem;padding:.65rem;border:1px solid #8c959f;border-radius:6px;font:inherit}.auth-card .check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}.auth-card .check input{margin-top:.35rem}.auth-card button{padding:.6rem 1rem;border:1px solid #1f2328;border-radius:7px;background:#1f2328;color:#fff;cursor:pointer;font:inherit}.auth-card .error{padding:.75rem;border-radius:7px;background:#ffebe9;color:#cf222e}.auth-card .help{padding:1rem;background:#f6f8fa;border-radius:8px;color:#57606a;font-size:.92rem}.auth-card code{word-break:break-word}${extraCss}</style></head>
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
  return managementPage('Source', `<h1>Source</h1><h2>Organizations</h2><table><tr><th>Name</th><th>Slug</th><th>Visibility</th></tr>${rows || '<tr><td colspan="3">none</td></tr>'}</table><div class="card"><h2>Create organization</h2><form method="POST" action="/admin/orgs">${input('name', 'Name')} ${input('slug', 'Slug')}<button type="submit">Create organization</button></form></div>`, null, null);
}

export async function renderIndexAsync(src, orgId) {
  const org = await src.getOrgAsync(orgId);
  const projects = await src.listProjectsAsync(orgId, { limit: 1_000 });
  const rows = projects.map((p) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(p.id)}">${esc(p.name)}</a></td><td>${esc(p.slug)}</td><td>${esc(p.visibility)}</td></tr>`).join('');
  return managementPage(org ? org.name : 'Source', `<h1>${esc(org?.name ?? 'Source')}</h1><h2>Projects</h2><table><tr><th>Name</th><th>Slug</th><th>Visibility</th></tr>${rows || '<tr><td colspan="3">none</td></tr>'}</table><div class="card"><h2>Create project</h2><form method="POST" action="/o/${esc(orgId)}/projects">${input('name', 'Name')} ${input('slug', 'Slug')}<label>Description<textarea name="description" rows="3"></textarea></label><label>Visibility<select name="visibility"><option value="private">private</option><option value="public">public</option></select></label><button type="submit">Create project</button></form></div>`, orgId, null);
}

export async function renderProjectAsync(src, orgId, projectId) {
  const p = await src.getProjectAsync(orgId, projectId);
  if (!p) return page('Not found', '<h1>Not found</h1>');
  const [work, changes, workflows] = await Promise.all([
    src.listWorkAsync(orgId, projectId, { limit: 1_000 }),
    src.listChangesAsync(orgId, projectId, { limit: 1_000 }),
    src.listWorkflowsAsync(orgId, projectId, { limit: 1000 }),
  ]);
  const repositories = await Promise.all((p.repositories || []).map((id) => src.getRepositoryAsync(orgId, projectId, id)));
  const repoCards = repositories.filter(Boolean).map((repo) => `<div class="card"><h3><a href="/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repo.id)}/tree/${encodeURIComponent(repo.defaultBranch)}">${esc(repo.name)}</a></h3><p class="muted">${esc(repo.visibility)} · ${esc(repo.defaultBranch)}</p><code>/git/${esc(orgId)}/${esc(projectId)}/${esc(repo.id)}.git</code></div>`).join('');
  const workRows = work.map((w) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(projectId)}/w/${esc(w.id)}">${esc(w.id)}</a></td><td>${esc(w.intent)}</td><td><span class="badge">${esc(w.status)}</span></td></tr>`).join('');
  const changeRows = changes.map((c) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(c.id)}">${esc(c.id)}</a></td><td>${esc(c.workId)}</td><td><span class="badge">${esc(c.decisionState)}</span></td></tr>`).join('');
  const workflowRows = workflows.map((w) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(projectId)}/actions/${esc(w.id)}">${esc(w.name)}</a></td><td>${esc(w.triggers.join(', '))}</td><td>${w.enabled ? 'enabled' : 'disabled'}</td></tr>`).join('');
  return managementPage(p.name, `<h1>${esc(p.name)}</h1><p>${esc(p.description)}</p><div class="grid"><div class="card"><h2>Repositories</h2><div class="grid">${repoCards || '<p>No repositories yet.</p>'}</div><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/repos">${input('name', 'Repository name', 'main')} ${input('defaultBranch', 'Default branch', 'main')}<button type="submit">Add repository</button></form></div><div class="card"><h2>New work</h2><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/work"><label>Intent<textarea name="intent" rows="4" required></textarea></label><label>Requirements<textarea name="requirements" rows="3"></textarea></label><label>Acceptance conditions<textarea name="acceptanceConditions" rows="3"></textarea></label><button type="submit">Create work item</button></form></div></div>
<h2>Work</h2><table><tr><th>ID</th><th>Intent</th><th>Status</th></tr>${workRows || '<tr><td colspan="3">none</td></tr>'}</table>
<h2>Changes</h2><table><tr><th>ID</th><th>Work</th><th>Decision</th></tr>${changeRows || '<tr><td colspan="3">none</td></tr>'}</table>
<h2>Actions</h2><p><a href="/o/${esc(orgId)}/p/${esc(projectId)}/actions">Manage workflows and runs</a></p><table><tr><th>Workflow</th><th>Triggers</th><th>Status</th></tr>${workflowRows || '<tr><td colspan="3">none</td></tr>'}</table>`, orgId, projectId);
}

export async function renderWorkAsync(src, orgId, projectId, workId) {
  const w = await src.getWorkAsync(orgId, projectId, workId);
  if (!w) return page('Not found', '<h1>Not found</h1>');
  return managementPage(`Work ${w.id}`, `<h1>Work ${esc(w.id)}</h1>
<p><strong>Intent:</strong> ${esc(w.intent)}</p>
<p><strong>Status:</strong> <span class="badge">${esc(w.status)}</span> · <strong>Assignee:</strong> ${esc(w.assignee)}</p>
<div class="grid"><div class="card"><h2>Agent lifecycle</h2><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/w/${esc(workId)}/claim"><button type="submit">Claim work</button></form><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/w/${esc(workId)}/sessions">${input('baseCommit', 'Base commit (optional)')}<label>Environment JSON<textarea name="environment" rows="3">{}</textarea></label><button type="submit">Start session</button></form></div><div class="card"><h2>Agent context</h2><p>Use the bounded context endpoint for agent handoff:</p><pre>/api/v1/orgs/${esc(orgId)}/projects/${esc(projectId)}/work/${esc(workId)}/context</pre></div></div>
<h2>Requirements</h2><ul>${w.requirements.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Acceptance conditions</h2><ul>${w.acceptanceConditions.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Sessions</h2><ul>${w.sessions.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>none</li>'}</ul>
<h2>Changes</h2><ul>${w.changes.map((c) => `<li><a href="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(c)}">${esc(c)}</a></li>`).join('') || '<li>none</li>'}</ul>`, orgId, projectId);
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
  return managementPage(`Change ${c.id}`, `<h1>Change ${esc(c.id)}</h1>
<h2>What was requested</h2><p>${esc(work?.intent ?? '')}</p>
<h2>What changed</h2><p>base <code>${esc(c.baseCommit)}</code> → head <code>${esc(c.headCommit)}</code></p>
<div class="grid"><div class="card"><h2>Review</h2><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(changeId)}/decision"><label>Decision<select name="decision"><option value="accepted">Accept and approve</option><option value="revision_requested">Request changes</option><option value="rejected">Reject</option></select></label><label>Reasoning<textarea name="reasoning" rows="4"></textarea></label><button type="submit">Record decision</button></form><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(changeId)}/evaluate"><button type="submit">Evaluate policy evidence</button></form>${c.decisionState === 'accepted' ? `<form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(changeId)}/canonical"><button type="submit">Merge into canonical Git</button></form>` : ''}<p><a href="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(changeId)}/scan">Scan secrets</a></p></div><div class="card"><h2>Add evidence</h2><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/c/${esc(changeId)}/evidence">${input('type', 'Type', 'human_review')} ${input('claim', 'Claim', '')} ${input('producer', 'Producer', 'web')}<label>Result JSON<textarea name="result" rows="3">{}</textarea></label><button type="submit">Add evidence</button></form></div></div>
<h2>What proves it</h2><table><tr><th>ID</th><th>Type</th><th>Claim</th><th>Validity</th></tr>${evidenceRows || '<tr><td colspan=4>none</td></tr>'}</table>
<h2>What requires attention</h2><ul>${interpretation}</ul>
<h2>Decision</h2><table><tr><th>ID</th><th>Decision</th><th>Decider</th><th>Reasoning</th></tr>${decisionRows || '<tr><td colspan=4>none</td></tr>'}</table>
<h2>Technical details</h2><pre>${esc(JSON.stringify({ baseCommit: c.baseCommit, headCommit: c.headCommit, reviewState: c.reviewState, decisionState: c.decisionState }, null, 2))}</pre>`, orgId, projectId);
}

export function renderLogin(opts = {}) {
  const errorText = opts.error === 'missing credential' ? 'Sign in to access this Source instance.' : opts.error;
  const error = errorText ? `<p class="error" role="alert">${esc(errorText)}</p>` : '';
  return page(
    'Source Login',
    `<main class="auth-shell"><section class="auth-card" aria-labelledby="login-title"><p class="brand">Source · local control plane</p><h1 id="login-title">Sign in with a human principal</h1>
<p>Use the principal, organization, and project IDs created for this Source instance.</p>
${error}
<form method="POST" action="/login">
  <label for="principal-id">Principal ID <input id="principal-id" name="principalId" placeholder="e.g. U1" autocomplete="username" required /></label>
  <label for="password">Password <input id="password" type="password" name="password" autocomplete="current-password" required /></label>
  <label for="org-id">Org ID <input id="org-id" name="orgId" placeholder="e.g. O1" required /></label>
  <label for="project-id">Project ID <input id="project-id" name="projectId" placeholder="e.g. P1" required /></label>
  <label class="check"><input type="checkbox" name="management" value="1" /> <span>Enable project management controls (role-gated)</span></label>
  <button type="submit">Sign in</button>
</form><div class="help"><strong>Starting a fresh local instance?</strong><br/>Run <code>node bin/source.js demo --password 'choose-a-strong-password'</code>, then use the IDs printed by the command. Source never ships with a default password.</div></section></main>`,
  );
}

// The management surface intentionally stays server-rendered: it works from a
// browser with no frontend build step, while the JSON API remains the stable
// agent-facing contract. Mutating forms are routed through the same capability
// checks as API clients.
function nav(orgId, projectId) {
  const project = orgId && projectId ? ` <a href="/o/${esc(orgId)}/p/${esc(projectId)}">Project</a> · <a href="/o/${esc(orgId)}/p/${esc(projectId)}/actions">Actions</a> · <a href="/o/${esc(orgId)}/p/${esc(projectId)}/settings">Settings</a>` : '';
  const home = orgId && projectId ? `/o/${esc(orgId)}/p/${esc(projectId)}` : '/';
  return `<nav><a href="${home}">Source</a>${project} · <form class="inline" method="POST" action="/logout"><button>Sign out</button></form></nav>`;
}

function input(name, label, value = '', type = 'text') {
  return `<label>${esc(label)}<input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" /></label>`;
}

export function managementPage(title, body, orgId, projectId) {
  const css = '.inline{display:inline}nav{display:flex;gap:.6rem;align-items:center;margin-bottom:1.5rem;padding:.75rem 1rem;background:#1f2328;border-radius:10px}nav a{color:#fff;font-weight:600}nav form{margin:0 0 0 auto;padding:0;background:transparent}form{background:#f6f8fa;padding:1rem;border-radius:8px;margin:1rem 0}label{display:block;margin:.5rem 0}input,textarea,select{display:block;width:100%;max-width:680px;padding:.5rem;border:1px solid #ccd1d5;border-radius:5px;box-sizing:border-box;font:inherit}button{padding:.45rem .8rem;border:1px solid #87909a;border-radius:5px;background:#fff;cursor:pointer;font:inherit}a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}.card{border:1px solid #d0d7de;border-radius:8px;padding:1rem;background:#fff}.muted{color:#57606a;font-size:.9rem}';
  return page(title, `${nav(orgId, projectId)}${body}`, css);
}

export async function renderRepositoryAsync(src, orgId, projectId, repoId, ref = 'HEAD', directory = '') {
  const repo = await src.getRepositoryAsync(orgId, projectId, repoId);
  if (!repo) return managementPage('Not found', '<h1>Repository not found</h1>', orgId, projectId);
  const git = src.gitRepo(orgId, projectId, repoId);
  const [branches, commits, entries, tip] = await Promise.all([
    git.listBranchesAsync(),
    git.listCommitsAsync(ref),
    git.listTreeAsync(ref, directory),
    git.revParseAsync(ref),
  ]);
  const prefix = directory ? `${directory.replace(/\/$/, '')}/` : '';
  const parent = directory ? directory.split('/').slice(0, -1).join('/') : '';
  const entryRows = entries.map((entry) => {
    const next = `${prefix}${entry.name}`;
    const href = entry.type === 'tree'
      ? `/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/tree/${encodeURIComponent(ref)}/${next.split('/').map(encodeURIComponent).join('/')}`
      : `/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/blob/${encodeURIComponent(ref)}/${next.split('/').map(encodeURIComponent).join('/')}`;
    return `<tr><td>${entry.type === 'tree' ? '📁' : '📄'} <a href="${href}">${esc(entry.name)}</a></td><td>${esc(entry.type)}</td><td>${esc(entry.hash.slice(0, 12))}</td></tr>`;
  }).join('');
  const commitRows = commits.map((commit) => `<tr><td><a href="/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/commit/${esc(commit.hash)}"><code>${esc(commit.hash.slice(0, 12))}</code></a></td><td>${esc(commit.subject)}</td><td>${esc(commit.author)}</td><td>${esc(commit.date)}</td></tr>`).join('');
  const branchLinks = branches.map((branch) => `<a href="/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/tree/${encodeURIComponent(branch.name)}">${esc(branch.name)}</a>`).join(' · ') || '<span class="muted">unborn repository</span>';
  const cloneUrl = `/git/${encodeURIComponent(orgId)}/${encodeURIComponent(projectId)}/${encodeURIComponent(repo.id)}.git`;
  return managementPage(repo.name, `<h1>${esc(repo.name)}</h1><p class="muted">${esc(repo.visibility)} · default branch ${esc(repo.defaultBranch)} · tip <code>${esc(tip || 'unborn')}</code> · <a href="/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/settings">settings</a></p>
<div class="card"><strong>Clone URL</strong><pre>${esc(cloneUrl)}</pre><p class="muted">Use a Source Git capability for private reads and pushes.</p></div>
<h2>Branches</h2><p>${branchLinks}</p>
<h2>Files <span class="muted">${esc(directory || '/')} @ ${esc(ref)}</span></h2>
${directory ? `<p><a href="/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/tree/${encodeURIComponent(ref)}/${parent.split('/').map(encodeURIComponent).join('/')}">← parent</a></p>` : ''}
<table><tr><th>Name</th><th>Type</th><th>Object</th></tr>${entryRows || '<tr><td colspan="3">No files at this ref.</td></tr>'}</table>
<h2>Recent commits</h2><table><tr><th>Commit</th><th>Subject</th><th>Author</th><th>Date</th></tr>${commitRows || '<tr><td colspan="4">No commits yet.</td></tr>'}</table>`, orgId, projectId);
}

export async function renderCommitAsync(src, orgId, projectId, repoId, hash) {
  const repo = await src.getRepositoryAsync(orgId, projectId, repoId);
  if (!repo) return managementPage('Not found', '<h1>Repository not found</h1>', orgId, projectId);
  const diff = await src.gitRepo(orgId, projectId, repoId).commitDiffAsync(hash);
  return managementPage(`Commit ${hash.slice(0, 12)}`, `<h1>Commit <code>${esc(hash.slice(0, 12))}</code></h1><p><a href="/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/tree/${encodeURIComponent(repo.defaultBranch)}">← repository</a></p><pre>${esc(diff || 'Commit not found')}</pre>`, orgId, projectId);
}

export async function renderRepositorySettingsAsync(src, orgId, projectId, repoId) {
  const repo = await src.getRepositoryAsync(orgId, projectId, repoId);
  if (!repo) return managementPage('Not found', '<h1>Repository not found</h1>', orgId, projectId);
  return managementPage(`${repo.name} settings`, `<h1>${esc(repo.name)} settings</h1><p><a href="/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/tree/${encodeURIComponent(repo.defaultBranch)}">← repository</a></p><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/settings">${input('name', 'Repository name', repo.name)} ${input('defaultBranch', 'Default branch', repo.defaultBranch)}<button type="submit">Save repository settings</button></form><div class="card"><h2>Transport</h2><p><code>/git/${esc(orgId)}/${esc(projectId)}/${esc(repo.id)}.git</code></p><p>Visibility follows the project policy: <strong>${esc(repo.visibility)}</strong>.</p></div>`, orgId, projectId);
}

export async function renderBlobAsync(src, orgId, projectId, repoId, ref, filePath) {
  const repo = await src.getRepositoryAsync(orgId, projectId, repoId);
  if (!repo) return managementPage('Not found', '<h1>Repository not found</h1>', orgId, projectId);
  const content = await src.gitRepo(orgId, projectId, repoId).showFileAsync(ref, filePath).catch(() => null);
  if (content == null) return managementPage('Not found', '<h1>File not found</h1>', orgId, projectId);
  const directory = filePath.split('/').slice(0, -1).join('/');
  return managementPage(filePath, `<h1>${esc(filePath)}</h1><p><a href="/o/${esc(orgId)}/p/${esc(projectId)}/r/${esc(repoId)}/tree/${encodeURIComponent(ref)}${directory ? `/${directory.split('/').map(encodeURIComponent).join('/')}` : ''}">← back to tree</a></p><pre>${esc(content)}</pre>`, orgId, projectId);
}

export async function renderActionsAsync(src, orgId, projectId) {
  const [project, workflows, jobs] = await Promise.all([
    src.getProjectAsync(orgId, projectId),
    src.listWorkflowsAsync(orgId, projectId, { limit: 1000 }),
    src.jobs.list({ orgId, projectId, limit: 100 }).catch(() => []),
  ]);
  const workflowCards = workflows.map((workflow) => `<div class="card"><h3><a href="/o/${esc(orgId)}/p/${esc(projectId)}/actions/${esc(workflow.id)}">${esc(workflow.name)}</a></h3><p>${esc(workflow.triggers.join(', '))} · ${workflow.enabled ? 'enabled' : 'disabled'}</p><p class="muted">${workflow.jobs.length} job definition(s)</p></div>`).join('');
  const jobRows = jobs.map((job) => `<tr><td><code>${esc(job.id)}</code></td><td>${esc(job.kind)}</td><td>${esc(job.status)}</td><td>${esc(job.attempts ?? 0)}</td><td>${esc(job.createdAt || '')}</td></tr>`).join('');
  return managementPage(`${project?.name || 'Project'} Actions`, `<h1>Actions & workflows</h1><p class="muted">Define durable workflows, import GitHub Actions, dispatch events, and inspect the worker queue.</p>
<div class="grid"><div class="card"><h2>Create workflow</h2><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/actions"><label>Name<input name="name" required maxlength="120" /></label><label>Triggers<input name="triggers" value="push" required /></label><label>Jobs (JSON)<textarea name="jobs" rows="8">[{"kind":"agent.workflow.check","payload":{"command":"kujo check"}}]</textarea></label><button type="submit">Create workflow</button></form></div>
<div class="card"><h2>Import GitHub Actions</h2><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/actions/import"><label>Repository<input name="repository" required placeholder="R1 or main" /></label><label>Workflow path<input name="path" value=".github/workflows/ci.yml" required /></label><label>Ref<input name="ref" value="HEAD" /></label><button type="submit">Import workflow</button></form></div></div>
<h2>Workflows</h2><div class="grid">${workflowCards || '<p>No workflows defined.</p>'}</div>
<h2>Recent runs / jobs</h2><table><tr><th>ID</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Created</th></tr>${jobRows || '<tr><td colspan="5">No jobs dispatched.</td></tr>'}</table>`, orgId, projectId);
}

export async function renderActionDetailAsync(src, orgId, projectId, workflowId) {
  const workflow = await src.getWorkflowAsync(orgId, projectId, workflowId);
  if (!workflow) return managementPage('Not found', '<h1>Workflow not found</h1>', orgId, projectId);
  const jobs = await src.jobs.list({ orgId, projectId, limit: 100 }).catch(() => []);
  const related = jobs.filter((job) => job.payload?.workflowId === workflowId);
  const definitions = workflow.jobs.map((job, i) => `<li><code>${esc(job.kind)}</code> <pre>${esc(JSON.stringify(job.payload || {}, null, 2))}</pre></li>`).join('');
  const runs = related.map((job) => `<tr><td>${esc(job.id)}</td><td>${esc(job.status)}</td><td>${esc(job.attempts ?? 0)}</td><td>${esc(job.updatedAt || job.createdAt || '')}</td><td><pre>${esc(JSON.stringify(job.result || job.error || {}, null, 2))}</pre></td></tr>`).join('');
  return managementPage(workflow.name, `<h1>${esc(workflow.name)}</h1><p>Triggers: ${esc(workflow.triggers.join(', '))} · version ${esc(workflow.version)}</p><h2>Dispatch</h2><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/actions/${esc(workflowId)}/dispatch">${input('event', 'Event', workflow.triggers[0] || 'manual')} ${input('eventId', 'Event ID (optional)')}<label>Payload JSON<textarea name="payload" rows="6">{}</textarea></label><button type="submit">Run workflow</button></form><h2>Job definitions</h2><ol>${definitions}</ol><h2>Runs and logs</h2><table><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Updated</th><th>Result / error</th></tr>${runs || '<tr><td colspan="5">No runs yet. Start a worker to execute queued jobs.</td></tr>'}</table>`, orgId, projectId);
}

export async function renderSettingsAsync(src, orgId, projectId) {
  const [org, project, members] = await Promise.all([src.getOrgAsync(orgId), src.getProjectAsync(orgId, projectId), src.listOrgMembersAsync?.(orgId) || []]);
  const memberRows = (members || []).map((member) => `<tr><td>${esc(member.principalId)}</td><td>${esc(member.role)}</td><td>${esc(member.createdAt)}</td></tr>`).join('');
  return managementPage('Settings', `<h1>Project settings</h1><div class="grid"><div class="card"><h2>Identity</h2><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/settings/project">${input('name', 'Project name', project?.name)}<label>Description<textarea name="description" rows="3">${esc(project?.description)}</textarea></label><label>Visibility<select name="visibility"><option value="private" ${project?.visibility === 'private' ? 'selected' : ''}>private</option><option value="public" ${project?.visibility === 'public' ? 'selected' : ''}>public</option></select></label><button type="submit">Save project settings</button></form></div><div class="card"><h2>Deployment</h2><p>Production mutations require Postgres writer fencing. Action execution is isolated in separate workers with signed manifests and brokered secrets.</p><p><a href="/.well-known/source">View agent discovery manifest</a> · <a href="/metrics">View metrics</a></p></div></div>
<h2>Collaborators</h2><table><tr><th>Principal</th><th>Role</th><th>Added</th></tr>${memberRows || '<tr><td colspan="3">No collaborators recorded.</td></tr>'}</table><form method="POST" action="/o/${esc(orgId)}/p/${esc(projectId)}/settings/members"><h3>Add collaborator</h3>${input('principalId', 'Principal ID')}<label>Role<select name="role"><option>member</option><option>maintainer</option><option>admin</option></select></label><button type="submit">Add collaborator</button></form>
<h2>Secrets and credentials</h2><div class="card"><p>Workflow secrets are issued as short-lived leases by the configured external secret provider; raw secret values are never stored or rendered here.</p><p>Git credentials are capability tokens issued by the operator or agent-facing API and should be delivered through your identity system.</p></div><h2>Administration boundary</h2><p class="muted">Repository, workflow, member, and credential mutations remain capability-gated. This page exposes the deployment contract rather than weakening those boundaries.</p>`, orgId, projectId);
}
