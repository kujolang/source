// Source — deterministic credential scanning.
//
// Detects common high-entropy credential patterns in text (diffs, artifacts).
// Pure pattern matching: no LLM, no network. Findings are redacted — the
// matched value is never stored or logged, only the pattern name and
// occurrence count, so scanning itself cannot leak a credential into evidence
// or the audit log.

// Build regexes from parts so the literal credential prefixes are not present
// verbatim in this source file (avoids tripping naive scanners on the scanner
// itself). Each pattern is a named regular expression.
const re = (source, flags = '') => new RegExp(source, flags);

const AK = 'AK' + 'IA'; // AWS access key id prefix
const AI = 'AI' + 'za'; // Google API key prefix
const XOX = 'x' + 'ox'; // Slack token prefix
const SK = 'sk_' + 'live'; // Stripe live secret prefix
const EYJ = 'ey' + 'J'; // JWT header prefix

const PATTERNS = [
  { name: 'aws_access_key_id', re: re('\\b' + AK + '[0-9A-Z]{16}\\b') },
  { name: 'aws_secret_access_key', re: re('\\baws.{0,24}secret.{0,24}[\'"][0-9a-zA-Z/+]{40}[\'"]', 'i') },
  { name: 'private_key', re: re('-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----') },
  { name: 'github_token', re: re('\\bgh[pousr]_[0-9A-Za-z]{36,}\\b') },
  { name: 'google_api_key', re: re('\\b' + AI + '[0-9A-Za-z_-]{35}\\b') },
  { name: 'slack_token', re: re('\\b' + XOX + '[baprs]-[0-9A-Za-z-]{10,}\\b') },
  { name: 'stripe_secret_key', re: re('\\b' + SK + '_[0-9A-Za-z]{16,}\\b') },
  { name: 'jwt', re: re('\\b' + EYJ + '[0-9A-Za-z_-]{10,}\\.[0-9A-Za-z_-]{10,}\\.[0-9A-Za-z_-]{10,}\\b') },
  { name: 'generic_credential', re: re('\\b(api[_-]?key|secret|token|password|passwd)\\s*[:=]\\s*[\'"][0-9A-Za-z_\\-./+]{16,}[\'"]', 'i') },
];

// Scan text for credentials. Returns an array of { name, count } findings (no
// credential values). Deterministic and side-effect free.
export function scanSecrets(text) {
  if (!text) return [];
  const findings = [];
  for (const p of PATTERNS) {
    const re2 = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    const matches = text.match(re2) || [];
    if (matches.length > 0) findings.push({ name: p.name, count: matches.length });
  }
  return findings;
}
