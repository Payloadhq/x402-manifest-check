# x402-manifest-check

**Validate an x402 payment manifest before it costs you customers. By Payload.**

Zero dependencies, Node 18+. Fetches a site's `/.well-known/x402` manifest and
checks that agents can actually use it to pay: valid JSON, a usable endpoint
list, positive prices, named assets and networks, and, with `--probe`, that an
unpaid request to a listed endpoint returns a real `402` with machine-readable
payment requirements.

Understands two manifest shapes (`endpoints`; `paid_routes` for x402 v2 /
Bazaar discovery) and two 402 requirement shapes (v1 requirements object; x402
v2 envelope with `accepts[]`, base-unit amounts, CAIP-2 networks, and
`maxTimeoutSeconds` expiry).

## Install

The CLI is not published to npm. Install it from GitHub:

```bash
npm install -g github:Payloadhq/x402-manifest-check
```

Or run it from a checkout, no install needed:

```bash
git clone https://github.com/Payloadhq/x402-manifest-check.git
cd x402-manifest-check
node bin/x402-manifest-check.js https://api.example.com
```

## Usage

```bash
x402-manifest-check https://api.example.com              # validate the manifest
x402-manifest-check https://api.example.com --probe      # also probe a live 402
x402-manifest-check https://api.example.com --probe --endpoint /api/data
x402-manifest-check https://api.example.com --json       # machine-readable report
x402-manifest-check --help
```

Exit codes: `0` = pass (or no manifest found: informational), `1` =
validation failures, `2` = usage or network error. CI-friendly: fail the build
on `1`.

## GitHub Action

Check your x402 manifest on every deploy:

```yaml
- uses: payloadhq/x402-manifest-check@v1
  with:
    url: https://api.example.com
    endpoint: /api/data   # probe one endpoint (default: first in manifest)
    probe: 'true'         # validate the live 402 challenge (default true)
```

The step fails when the manifest is invalid or the live 402 challenge is
broken: malformed challenges, wrong network, or manifest drift get caught
before production.

## Example

```bash
$ x402-manifest-check https://api.example.com --probe --endpoint /price
✓ HTTP 402 Payment Required
✓ machine-readable requirements (x402 v2, 1 payment option)
✓ payTo 0x68614873C5d624c07DCAA3aFF5243DD5027c391
✓ requirements valid for 300s
✓ 0 errors, 2 warnings: PASS
```

A site with no manifest reports cleanly instead of failing: no manifest found
(HTTP 404 at `/.well-known/x402`). Nothing to validate.

## What it checks

**Manifest** (errors fail the check): reachable at `/.well-known/x402`
(HTTP 200, JSON content); valid JSON with an `endpoints` or `paid_routes`
array; each endpoint has an absolute `path`, a positive `price`, and named
`asset` and `network`.

**Manifest** (warnings): `payTo` not advertised; missing `description`,
`method`, or `baseUrl`; unknown network names; placeholder addresses.

**Probe** (`--probe`, one unpaid request): returns HTTP `402`; carries
machine-readable requirements (`payment-required` header or
`paymentRequirements` body); requirements name `amount`, `asset`, `network`,
and `payTo` (real address, not a placeholder); sane expiry (60s-1h); a
nonce/`id` present (replay defense); **manifest drift**: the live 402's
price/asset/network agree with the manifest (understands v2 base-unit amounts,
e.g. `10000` micro-USDC = `$0.01`).

## Limitations

- Validates the **manifest and the 402 challenge** only. It does **not** verify
  payments, settle transactions, or audit your verifier. A passing check
  doesn't mean payments actually clear.
- One unpaid request per probe; it never pays anything.
- Address checks are format-level (EVM hex / base58), not checksum or
  on-chain verification.
- The v2 base-unit conversion assumes 6-decimal assets (USDC); exotic assets
  may need manual review.

## When the check finds real problems

- **Manifest broken in production:** callx402 by Payload — powered by Veyline
  diagnoses and rescues broken x402 calls. When x402 breaks, callx402.
- **Implementation to build against:** the
  [Veyline Developer Primer](https://payloadtools.gumroad.com/l/x402-paid-api-starter-kit)
  (formerly the x402 Paid API Starter Kit, $79): Express middleware, manifest
  route, ledger, and end-to-end tests included.

Built by [Payload](https://payloadhq.github.io/).

## License

MIT. See [LICENSE](LICENSE).

---

**More from Payload** · [payloadhq.github.io](https://payloadhq.github.io/) · [all Payload repos](https://github.com/Payloadhq)

Related: [x402-failure-mode-benchmark](https://github.com/Payloadhq/x402-failure-mode-benchmark) · [x402-observatory](https://github.com/Payloadhq/x402-observatory) · [callx402](https://github.com/Payloadhq/callx402)
