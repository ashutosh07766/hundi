# hundi

Make any online store agent-transactable. `hundi init` scans a storefront, generates the machine-readable surface an AI shopping agent needs to browse and buy from it (`llms.txt`, a `.well-known/hundi.json` capability manifest, and a structured catalog adapter), and can optionally register the merchant with a Hundi trust facilitator so agent-initiated carts have somewhere safe to settle.

```bash
npx hundi init https://your-store.com
```

This writes three files into `./hundi-out` (override with `--out <dir>`):

- **`llms.txt`** — the [llmstxt.org](https://llmstxt.org) format: a short orientation doc an agent fetches first, pointing at the structured catalog.
- **`.well-known/hundi.json`** — a capability manifest declaring the catalog endpoint, currency, and a hint that carts should be submitted to a Hundi facilitator for settlement.
- **`catalog-adapter.json`** — every product Hundi found, normalized to `{ sku, name, description, price_paise, currency, availability, image, brand }`, with prices in integer paise so downstream consumers never touch floating-point money.

The scanner tries schema.org `Product` JSON-LD first — the widely-supported way stores expose structured product data — and falls back to Shopify's `/products.json` storefront feed when a theme omits JSON-LD entirely. Every outbound request goes through an SSRF-guarded fetch (private/loopback IP rejection, capped redirects, capped body size, http(s)-only).

To register the scanned merchant with a running facilitator instead of only writing local files:

```bash
npx hundi init https://your-store.com --register \
  --facilitator https://your-facilitator.example \
  --admin-token <token>
```

Registration is create-only and idempotent — running it again against an already-registered merchant reports "already registered" rather than failing.

## What Hundi is

Hundi is an open trust envelope for AI-agent-initiated payments: a human signs a scoped spending mandate, a buyer agent assembles a cart against a merchant's generated catalog, and a facilitator — the only process holding payment-provider keys — decides whether it settles. The agent is never handed a settle capability to misuse in the first place; that's enforced by the shape of the interface, not a rule it has to remember. The reference facilitator deployment settles through **Razorpay in TEST mode only** — no live payment keys are involved anywhere in this flow. See the full project, the facilitator, and the mandate/settlement design at [github.com/ashutosh07766/hundi](https://github.com/ashutosh07766/hundi).

## License

MIT
