#!/usr/bin/env node
/**
 * Lightweight secret scanner for the NOVA repository.
 *
 * Scans (a) every tracked file in the working tree and (b) every blob reachable
 * from the full Git history, looking for credential-shaped content. It is not a
 * replacement for gitleaks/trufflehog — it is the CI-enforceable baseline so a
 * committed key cannot pass silently.
 *
 * Usage: node scripts/scan-secrets.mjs [--history] [--max-findings 50]
 * Exit code 1 when a finding is reported.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const includeHistory = args.includes('--history') || !args.includes('--no-history');
const maxIndex = args.indexOf('--max-findings');
const maxFindings = maxIndex >= 0 ? Number(args[maxIndex + 1]) || 50 : 50;

const RULES = [
  { id: 'private-key', label: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { id: 'openai-key', label: 'OpenAI-style API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'github-token', label: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { id: 'github-pat', label: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { id: 'aws-key', label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'google-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-key', label: 'Stripe secret key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'brave-key', label: 'Brave Search subscription token', re: /\bBSA[A-Za-z0-9_-]{20,}\b/ },
  { id: 'jwt', label: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: 'assigned-secret',
    label: 'Hard-coded credential assignment',
    re: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]([A-Za-z0-9+/_=-]{24,})['"]/i,
    // Test fixtures legitimately create throwaway credentials; real leaks in
    // production code or configuration still trip this rule.
    skipPath: /(?:^|\/)(?:test|tests|__tests__|fixtures?)\//,
    allow: (match) => /(?:replace-with|example|placeholder|your-|test-|dummy|xxx+|change-me|\$\{|process\.env|<)/i.test(match),
  },
];

const ALLOWLIST_PATHS = [
  /^node_modules\//,
  /^client\/dist\//,
  /^backups\//,
  /^package-lock\.json$/,
  /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|eot|sqlite(?:-\w+)?|zip|gz|mp4|pdf)$/i,
];
const ALLOWLIST_LINES = [
  /replace-with-at-least-32-random-characters/,
  /SESSION_SECRET must contain at least 32 characters/,
  /test-secret-with-more-than-32-characters/,
  /hardening-secret-with-more-than-32-characters/,
  /e2e-session-secret-with-more-than-32-characters/,
  /test-provider-encryption-key-with-32-plus-characters/,
  /hardening-provider-key-with-32-plus-chars/,
  /e2e-provider-encryption-key-32-plus-chars/,
  /\bsk-ant-\*\*/,
  /\bsk-\*\*/,
];

function isAllowlisted(file, line) {
  if (ALLOWLIST_PATHS.some((re) => re.test(file))) return true;
  return ALLOWLIST_LINES.some((re) => re.test(line));
}

function scanText(file, text, findings, origin) {
  if (!text || text.length > 2_000_000) return;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 4000) continue;
    if (isAllowlisted(file, line)) continue;
    for (const rule of RULES) {
      if (rule.skipPath && rule.skipPath.test(file)) continue;
      const match = rule.re.exec(line);
      if (!match) continue;
      if (rule.allow && rule.allow(match[0])) continue;
      findings.push({
        rule: rule.id,
        label: rule.label,
        file,
        line: index + 1,
        origin,
        preview: line.trim().slice(0, 160).replace(/[A-Za-z0-9_-]{16,}/g, (value) => value.slice(0, 4) + '***'),
      });
      break;
    }
  }
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

function isShallowClone() {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: rootDir, encoding: 'utf8' }).trim() === 'true';
  } catch {
    return false;
  }
}

function historyBlobs() {
  const output = execFileSync(
    'git',
    ['rev-list', '--objects', '--all'],
    { cwd: rootDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const seen = new Set();
  const blobs = [];
  for (const row of output.split('\n')) {
    const [sha, ...nameParts] = row.split(' ');
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const name = nameParts.join(' ') || sha;
    if (seen.has(sha)) continue;
    seen.add(sha);
    blobs.push({ sha, name });
  }
  return blobs;
}

function main() {
  const findings = [];
  let scannedFiles = 0;

  for (const file of trackedFiles()) {
    if (ALLOWLIST_PATHS.some((re) => re.test(file))) continue;
    const absolute = path.join(rootDir, file);
    let stats;
    try { stats = fs.statSync(absolute); } catch { continue; }
    if (!stats.isFile() || stats.size > 2_000_000) continue;
    let text;
    try { text = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
    scannedFiles += 1;
    scanText(file, text, findings, 'working-tree');
    if (findings.length > maxFindings * 4) break;
  }

  let scannedBlobs = 0;
  const shallow = isShallowClone();
  if (includeHistory && shallow) {
    console.error('[scan-secrets] warning: shallow clone detected; history coverage is limited to the fetched depth. Use fetch-depth: 0 for a full scan.');
  }
  if (includeHistory) {
    const blobs = historyBlobs();
    for (const blob of blobs) {
      if (ALLOWLIST_PATHS.some((re) => re.test(blob.name))) continue;
      let text;
      try {
        text = execFileSync('git', ['cat-file', '-p', blob.sha], {
          cwd: rootDir,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch { continue; }
      scannedBlobs += 1;
      scanText(blob.name, text, findings, 'history:' + blob.sha.slice(0, 12));
      if (findings.length > maxFindings * 4) break;
    }
  }

  const unique = [];
  const seen = new Set();
  for (const finding of findings) {
    const key = [finding.rule, finding.file, finding.line, finding.preview].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  const byRule = {};
  for (const finding of unique) byRule[finding.rule] = (byRule[finding.rule] || 0) + 1;
  const report = {
    ok: unique.length === 0,
    byRule,
    scannedFiles,
    scannedBlobs,
    historyIncluded: includeHistory,
    shallowClone: shallow,
    findings: unique.slice(0, maxFindings),
    truncated: unique.length > maxFindings,
    note: 'Pattern + assignment heuristics only. Absence of findings is not proof that no secret ever leaked; pair with gitleaks/trufflehog and provider-side key rotation.',
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main();
