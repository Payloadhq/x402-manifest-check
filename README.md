# x402-manifest-check

Validate an x402 payment manifest. Zero dependencies, Node 18+.

`x402-manifest-check` fetches a site's `/.well-known/x402` manifest and checks that agents can actually use it to pay: valid JSON, a usable endpoint list, positive prices, named assets and networks — and, with `--probe`, that an unpaid request to a listed endpoint returns a real `402` with machine-readable payment requirements.

It understands two manifest shapes found in the wild:

- `endpoints` — `[{ method, path, price, asset, network, payTo?, description? }]`
- `paid_routes` (x402 v2 / Bazaar discovery) — `[{ route_key, method, path, resource_url, price: "$0.01", description? }]`

…and two 402 requirement shapes: the v1 requirements object and the x402 v2 envelope (`accepts[]` with base-unit amounts, CAIP-2 networks, `maxTimeoutSeconds` expiry).

## Install

```bash
npx x402-manifest-check <url>
```

No install needed — `npx` fetches it on demand. Or install globally:

```bash
npm install -g x402-manifest-check
```

## Usage

```bash
x402-manifest-check https://api.example.com              # validate the manifest
x402-manifest-check https://api.example.com --probe      # also probe a live 402
x402-manifest-check https://api.example.com --probe --endpoint /api/data
x402-manifest-check https://api.example.com --json       # machine-readable report
x402-manifest-check --help
```

Exit codes: `0` = pass (or no manifest found — informational), `1` = validation failures, `2` = usage or network error. CI-friendly: fail the build on `1`.

## GitHub Action

Check your x402 manifest on every deploy. Add to any workflow:

```yaml
- uses: payloadhq/x402-manifest-check@v1
  with:
    url: https://api.example.com
```

With options:

```yaml
- uses: payloadhq/x402-manifest-check@v1
  with:
    url: https://api.example.com
    endpoint: /api/data   # probe one endpoint (default: first in manifest)
    probe: 'true'         # validate the live 402 challenge (default true)
```

The step fails when the manifest is invalid or the live 402 challenge is
broken — malformed challenges, wrong network, or manifest drift get caught
before production.

## Example

```bash
$ x402-manifest-check https://x402.167-172-95-184.nip.io --probe --endpoint /price
x402 manifest check: https://x402.167-172-95-184.nip.io
manifest: https://x402.167-172-95-184.nip.io/.well-known/x402 (shape: paid_routes)

⚠ WARN  [endpoint-missing-asset] /price: "asset" is not advertised (e.g. "USDC"). The live 402 should name it — use --probe to verify.
⚠ WARN  [endpoint-no-payto] /price: "payTo" is not advertised. Agents cannot verify the recipient before paying; consider adding it.
…

endpoints checked: 9
  - GET /price — 0.01
  - GET /portfolio — 0.05
  …

probe: GET /price (no payment)
  ✓ HTTP 402 Payment Required
  ✓ machine-readable requirements via payment-required header (x402 v2, 1 payment option)
  ✓ payTo 0x68614873C5d624c07DCAA3aFF5243DD5027c3910
  ✓ requirements valid for 300s

✓ 0 errors, 29 warnings — PASS
```

A site with no manifest reports cleanly instead of failing:

```bash
$ x402-manifest-check https://payloadhq.github.io
x402 manifest check: https://payloadhq.github.io
manifest: https://payloadhq.github.io/.well-known/x402

○ no manifest found (HTTP 404 at /.well-known/x402)
  This site does not advertise x402 payments. Nothing to validate.
```

## What it checks

**Manifest** (errors fail the check):

- reachable at `/.well-known/x402` (HTTP 200, JSON content)
- body is valid JSON with an `endpoints` or `paid_routes` array
- each endpoint: `path` present and absolute, `price` a positive decimal (`"0.01"` or `"$0.01"`), `asset` and `network` named (in the `endpoints` shape; warnings in `paid_routes`, where the format leaves them to the 402)

**Manifest** (warnings — usable, but improvable):

- `payTo` not advertised (agents can't verify the recipient before paying)
- missing `description`, `method`, or `baseUrl`; unknown network names; placeholder addresses

**Probe** (`--probe`, unpaid request to a listed endpoint):

- returns HTTP `402` (not `200`, not a bare challenge)
- carries machine-readable requirements: `payment-required` header or `paymentRequirements` in the JSON body
- requirements name `amount`, `asset`, `network`, and `payTo`; `payTo` is a real address, not a placeholder
- expiry is sane (60s–1h); a nonce/`id` is present (replay defense)
- **manifest drift**: the live 402's price/asset/network agree with the manifest (understands v2 base-unit amounts, e.g. `10000` micro-USDC = `$0.01`)

## Limitations

- This validates the **manifest and the 402 challenge**. It does **not** verify payments, settle transactions, or audit your verifier — a passing check doesn't mean payments actually clear.
- It makes one unpaid request per probe; it never pays anything.
- Address checks are format-level (EVM hex / base58), not checksum or on-chain verification.
- The v2 base-unit conversion assumes 6-decimal assets (USDC); exotic assets may need manual review.

## If your manifest needs fixing

If the check fails on your API, the usual fixes are: add the missing fields to your manifest route, advertise `payTo`, and make sure the manifest prices match what your 402 handler actually enforces. If your manifest needs fixing, the [x402 Paid API Starter Kit](https://payloadtools.gumroad.com/l/x402-paid-api-starter-kit) is the implementation it was built against — Express middleware, manifest route, ledger, and end-to-end tests included.

Built by [Payload](https://payloadhq.github.io/) — small, sharp tools for developers.

## License

MIT — see [LICENSE](LICENSE).
