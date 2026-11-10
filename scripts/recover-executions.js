// Operator-only local recovery; no age-based or prefix-based container sweep.
import path from 'node:path';
import { recoverExecutionAttempts } from '../src/execution-attempts.js';
const [workspaceRoot, ...extra] = process.argv.slice(2);
if (!workspaceRoot || !path.isAbsolute(workspaceRoot) || extra.length) throw new Error('usage: node scripts/recover-executions.js /absolute/worker/workspace-root');
const report = await recoverExecutionAttempts({ workspaceRoot });
console.log(JSON.stringify(report, null, 2));
if (report.results.some(row => !['active', 'recovered'].includes(row.state))) process.exitCode = 2;
