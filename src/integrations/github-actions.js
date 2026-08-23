// Translate a bounded, data-only subset of GitHub Actions YAML into Source's
// workflow contract. Parsing never executes `run`, `uses`, expressions, or
// repository code; those remain untrusted step data for an isolated worker.

import yaml from 'js-yaml';

const EVENT_NAMES = new Set(['push', 'pull_request', 'workflow_dispatch', 'schedule', 'issues', 'issue_comment', 'release']);

function safeText(value, label, max = 16 * 1024) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be a bounded string`);
  return value;
}

function normalizeTriggers(value) {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value) : [];
  const triggers = [...new Set(raw.map((event) => safeText(event, 'workflow event', 120)))];
  if (!triggers.length || triggers.some((event) => !EVENT_NAMES.has(event))) throw new Error('workflow must use at least one supported GitHub event');
  return triggers;
}

export function translateGitHubActions(raw, { path = '.github/workflows/workflow.yml', repoId = null, ref = 'HEAD' } = {}) {
  safeText(raw, 'workflow YAML', 1_000_000);
  let document;
  try {
    document = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch {
    throw new Error('invalid GitHub Actions YAML');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('workflow YAML must be an object');
  const triggers = normalizeTriggers(document.on);
  if (!document.jobs || typeof document.jobs !== 'object' || Array.isArray(document.jobs)) throw new Error('workflow YAML must define jobs');
  const jobs = Object.entries(document.jobs);
  if (!jobs.length || jobs.length > 100) throw new Error('workflow YAML must define 1-100 jobs');
  const translated = jobs.map(([jobId, definition]) => {
    safeText(jobId, 'job id', 120);
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`job ${jobId} must be an object`);
    const steps = Array.isArray(definition.steps) ? definition.steps : [];
    if (steps.length > 100) throw new Error(`job ${jobId} has too many steps`);
    const boundedSteps = steps.map((step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`job ${jobId} contains an invalid step`);
      return {
        name: typeof step.name === 'string' ? step.name.slice(0, 240) : undefined,
        uses: typeof step.uses === 'string' ? step.uses.slice(0, 500) : undefined,
        run: typeof step.run === 'string' ? step.run.slice(0, 16 * 1024) : undefined,
        with: step.with && typeof step.with === 'object' ? step.with : undefined,
      };
    });
    return {
      kind: 'github.actions.job',
      payload: {
        jobId,
        runsOn: typeof definition['runs-on'] === 'string' ? definition['runs-on'].slice(0, 120) : 'self-hosted',
        needs: Array.isArray(definition.needs) ? definition.needs.slice(0, 100) : definition.needs || [],
        permissions: definition.permissions && typeof definition.permissions === 'object' ? definition.permissions : {},
        env: definition.env && typeof definition.env === 'object' ? definition.env : {},
        steps: boundedSteps,
      },
    };
  });
  const name = typeof document.name === 'string' && document.name ? document.name.slice(0, 160) : path.split('/').at(-1);
  return {
    name,
    triggers,
    jobs: translated,
    source: { provider: 'github-actions', repoId, ref, path },
  };
}
