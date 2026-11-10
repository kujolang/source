// Operator-authored applicability rules may reduce optional checks only when
// dependency/coverage information is explicitly complete. Unknowns run everything.
const prefix = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.startsWith('/') && !value.split('/').includes('..');
const related = (a, b) => a.startsWith(b) || b.startsWith(a);
const sensitive = /(^|\/)(auth[^/]*|security|permissions?|migrations?|schema[^/]*|infra|deploy[^/]*|generated|public-api)(\/|\.|$)|(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.(toml|lock)|go\.(mod|sum)|Dockerfile|\.github)(\/|$)/i;

export function planVerification(candidate, policy) {
  const all = (reason, paths = []) => ({ version: 1, conservative: true, reason, paths, checks: policy.checks.map((check) => ({ id: check.id, tier: check.tier ?? 2, reason })), omitted: [] });
  const model = policy.impact;
  if (!model || model.version !== '1' || model.complete !== true) return all('impact information absent or incomplete');
  if (!Array.isArray(model.coverage) || !model.coverage.length || !model.coverage.every(prefix) || !Array.isArray(model.dependencies) || model.dependencies.length > 1000 || !model.dependencies.every((edge) => prefix(edge?.from) && prefix(edge?.to))) return all('impact model is invalid');
  if (!candidate?.proposals?.length || !candidate.proposals.every((proposal) => Array.isArray(proposal?.files) && proposal.files.every((file) => file && typeof file === 'object'))) return all('changed-file inventory is missing');
  const paths = [...new Set(candidate.proposals.flatMap((proposal) => proposal.files.flatMap((file) => [file.from, file.to])))].sort();
  if (!paths.length || !paths.every(prefix)) return all('changed-file inventory is empty or invalid');
  if (paths.some((file) => !model.coverage.some((root) => file.startsWith(root)))) return all('changed paths lack declared coverage', paths);
  if (model.release === true) return all('release policy requires the full suite', paths);
  if (paths.some((file) => sensitive.test(file))) return all('security, API, dependency, schema, generated or deployment impact', paths);
  if (!policy.checks.some((check) => check.tier === 0) || !policy.checks.some((check) => check.tier === 2)) return all('preflight or combined-integration tier is unspecified', paths);
  if (model.failurePaths != null && (!Array.isArray(model.failurePaths) || !model.failurePaths.every(prefix))) return all('historical failure inputs are invalid', paths);
  if (model.sensitivePaths != null && (!Array.isArray(model.sensitivePaths) || !model.sensitivePaths.every(prefix))) return all('sensitive path policy is invalid', paths);
  if ((model.failurePaths || []).some((root) => paths.some((file) => related(file, root)))) return all('operator-trusted failure history requires the full suite', paths);
  const affected = new Set(paths);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of model.dependencies) {
      if (!affected.has(edge.from) && [...affected].some((file) => related(file, edge.to))) {
        affected.add(edge.from); changed = true;
      }
    }
  }
  if ([...affected].some((file) => sensitive.test(file) || [...(model.sensitivePaths || []), ...(model.failurePaths || [])].some((root) => related(file, root)))) return all('affected dependency reaches sensitive paths or trusted failure history', paths);
  const checks = [];
  const omitted = [];
  for (const check of policy.checks) {
    const tier = check.tier ?? 2;
    let reason;
    if (check.optionalByImpact !== true) reason = 'always-required check';
    else if (tier === 0 || tier === 2) reason = 'mandatory preflight/combined integration tier';
    else if (!Array.isArray(check.paths) || !check.paths.length || !check.paths.every(prefix)) reason = 'check applicability is unknown';
    else if (check.paths.some((root) => [...affected].some((file) => related(file, root)))) reason = 'changed path or transitive dependency affects this check';
    if (reason) checks.push({ id: check.id, tier, reason });
    else omitted.push({ id: check.id, reason: 'explicit optional applicability excludes the complete affected set' });
  }
  // Optional applicability cannot remove prerequisites of a selected check.
  const selected = new Set(checks.map((check) => check.id));
  for (let index = 0; index < checks.length; index++) {
    const definition = policy.checks.find((check) => check.id === checks[index].id);
    for (const id of definition.dependsOn || []) {
      const dependency = policy.checks.find((check) => check.id === id);
      if (!dependency) return all('verification dependency is unknown', paths);
      if (!selected.has(id)) {
        selected.add(id);
        checks.push({ id, tier: dependency.tier ?? 2, reason: 'prerequisite of selected verification' });
      }
    }
  }
  return { version: 1, conservative: false, reason: 'complete operator impact model', paths, affected: [...affected].sort(), checks, omitted: omitted.filter((check) => !selected.has(check.id)) };
}
