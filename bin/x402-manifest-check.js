#!/usr/bin/env node
/**
 * x402-manifest-check — validate an x402 payment manifest.
 *
 *   npx x402-manifest-check <url> [--probe] [--endpoint /path] [--json]
 *                          [--timeout ms]
 *
 * Exit codes: 0 = pass (or no manifest found — informational),
 *             1 = validation failures, 2 = usage/operational error.
 */
'use strict';

const { run } = require('../lib/check');

const VERSION = '1.0.0';

function printHelp() {
  console.log(`x402-manifest-check v${VERSION} — validate an x402 payment manifest

Usage:
  x402-manifest-check <url> [options]

  <url>       Site to check, e.g. https://api.example.com
              (the manifest is fetched from <url>/.well-known/x402)

Options:
  --probe             Also make an unpaid request to a listed endpoint and
                      validate the live 402 payment challenge.
  --endpoint <path>   Which manifest endpoint to probe (default: first one).
  --json              Machine-readable JSON report instead of text.
  --timeout <ms>      Request timeout in milliseconds (default 10000).
  -h, --help          Show this help. --version shows the version.

Checks:
  manifest   reachable, valid JSON, "endpoints" or "paid_routes" list present
             (supports the starter-kit shape and the x402 v2 / Bazaar shape)
  endpoint   path, positive price, asset, network (errors in "endpoints"
             shape; asset/network are warnings in "paid_routes", where the
             format leaves them to the live 402); method, payTo,
             description (warnings)
  probe      unpaid request returns 402 with machine-readable payment
             requirements; payTo present and not a placeholder; sane
             expiry (60s–1h); nonce present; 402 agrees with the manifest

Exit codes: 0 pass / no manifest found · 1 validation failures · 2 error

This validates the manifest and the 402 challenge — it does not verify
actual payments and is not a security audit.`);
}

function parseArgs(argv) {
  const opts = { url: null, probe: false, endpointPath: null, json: false, timeoutMs: 10000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--version') return { version: true };
    if (a === '--probe') opts.probe = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--timeout') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: '--timeout needs a positive number of milliseconds' };
      opts.timeoutMs = v;
    } else if (a === '--endpoint') {
      const v = argv[++i];
      if (!v) return { error: '--endpoint needs a path, e.g. --endpoint /api/joke' };
      opts.endpointPath = v;
    } else if (a.startsWith('-')) {
      return { error: 'unknown option: ' + a };
    } else rest.push(a);
  }
  if (rest.length === 0) return { error: 'missing <url> — e.g. x402-manifest-check https://api.example.com' };
  if (rest.length > 1) return { error: 'too many arguments — only one <url> is accepted' };
  opts.url = rest[0];
  return { opts };
}

function icon(list) {
  return list.length ? '✗' : '✓';
}

function printReport(report) {
  const out = [];
  out.push(`x402 manifest check: ${report.url}`);
  out.push(`manifest: ${report.manifestUrl}${report.manifestShape ? ` (shape: ${report.manifestShape})` : ''}`);

  if (report.summary === 'no manifest found') {
    out.push('');
    out.push('○ no manifest found (HTTP 404 at /.well-known/x402)');
    out.push('  This site does not advertise x402 payments. Nothing to validate.');
    console.log(out.join('\n'));
    return;
  }

  out.push('');
  for (const e of report.errors) out.push(`✗ ERROR [${e.code}] ${e.message}`);
  for (const w of report.warnings) out.push(`⚠ WARN  [${w.code}] ${w.message}`);
  if (report.errors.length === 0 && report.warnings.length === 0) {
    out.push('✓ manifest is valid JSON with a usable endpoints list');
  }

  if (report.endpoints.length > 0) {
    out.push('');
    out.push(`endpoints checked: ${report.endpoints.length}`);
    for (const ep of report.endpoints) {
      const bits = [ep.method, ep.path].filter(Boolean).join(' ');
      const detail = [ep.price ? `${ep.price}${ep.asset ? ' ' + ep.asset : ''}` : null, ep.network].filter(Boolean).join(' on ');
      out.push(`  - ${bits}${detail ? ` — ${detail}` : ''}`);
    }
  }

  if (report.probe) {
    const p = report.probe;
    out.push('');
    out.push(`probe: ${p.method} ${p.path} (no payment)`);
    out.push(`  ${p.status === 402 ? '✓' : '✗'} HTTP ${p.status}${p.status === 402 ? ' Payment Required' : ''}`);
    if (p.requirementsSource) out.push(`  ✓ machine-readable requirements via ${p.requirementsSource}`);
    if (p.payTo) out.push(`  ✓ payTo ${p.payTo}`);
    if (p.expiresInSec !== undefined) out.push(`  ${p.expiresInSec >= 60 && p.expiresInSec <= 3600 ? '✓' : '⚠'} requirements valid for ${p.expiresInSec}s`);
  }

  out.push('');
  const nE = report.errors.length, nW = report.warnings.length;
  out.push(`${icon(report.errors)} ${nE} error${nE === 1 ? '' : 's'}, ${nW} warning${nW === 1 ? '' : 's'} — ${report.ok ? 'PASS' : 'FAIL'}`);
  console.log(out.join('\n'));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { printHelp(); process.exit(0); }
  if (parsed.version) { console.log(VERSION); process.exit(0); }
  if (parsed.error) { console.error('x402-manifest-check: ' + parsed.error); console.error('Run with --help for usage.'); process.exit(2); }

  const { report, exitCode } = await run(parsed.opts.url, {
    probe: parsed.opts.probe,
    endpointPath: parsed.opts.endpointPath,
    timeoutMs: parsed.opts.timeoutMs,
  });

  if (parsed.opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('x402-manifest-check: unexpected error: ' + (err && err.message));
  process.exit(2);
});
