/**
 * Synthetic coffee & kitchenware catalog for the second demo storefront.
 * Hardcoded and deterministic, like apps/store's catalog, but a different
 * category, price band, and id/sku split: `id` is a human slug used for
 * internal linking, `sku` is a separate merchant code carried explicitly in
 * the rendered JSON-LD (apps/store has no `sku` field at all and relies on
 * the scanner deriving one from the product URL).
 */

export type Availability = 'in_stock' | 'out_of_stock'

export type Product = {
  id: string
  sku: string
  title: string
  description: string
  /** Integer price in paise (1/100 rupee) — the scanner's own unit, so
   * round-trip tests can compare without a conversion step. */
  price_paise: number
  currency: 'INR'
  availability: Availability
  image: string
  brand: string
  rating: { value: number; count: number }
}

export const MERCHANT_ID = 'demo-store-2'

export const catalog: readonly Product[] = [
  {
    id: 'french-press-classic',
    sku: 'KW-001',
    title: 'BrewCraft Classic French Press 350ml',
    description: 'Borosilicate glass press with a 4-part stainless mesh filter for daily brewing.',
    price_paise: 89900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-001/600/600',
    brand: 'BrewCraft',
    rating: { value: 4.4, count: 312 },
  },
  {
    id: 'french-press-grand',
    sku: 'KW-002',
    title: 'BrewCraft Grand French Press 1L',
    description: 'Full-size press built for sharing, with a double-wall insulated steel body.',
    price_paise: 149900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-002/600/600',
    brand: 'BrewCraft',
    rating: { value: 4.5, count: 198 },
  },
  {
    id: 'pour-over-kettle',
    sku: 'KW-003',
    title: 'CopperPour Gooseneck Kettle 900ml',
    description: 'Thin-spout gooseneck kettle for controlled pour-over flow rates.',
    price_paise: 219900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-003/600/600',
    brand: 'CopperPour',
    rating: { value: 4.7, count: 540 },
  },
  {
    id: 'pour-over-kettle-electric',
    sku: 'KW-004',
    title: 'CopperPour Precision Kettle E1',
    description: 'Electric gooseneck kettle with 1-degree temperature hold for pour-over dialing.',
    price_paise: 499900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-004/600/600',
    brand: 'CopperPour',
    rating: { value: 4.6, count: 276 },
  },
  {
    id: 'hand-grinder',
    sku: 'KW-005',
    title: 'Grind Labs Hand Mill Conical Burr',
    description: 'Portable manual grinder with a stainless conical burr and stepped adjustment.',
    price_paise: 179900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-005/600/600',
    brand: 'Grind Labs',
    rating: { value: 4.3, count: 421 },
  },
  {
    id: 'burr-grinder-electric',
    sku: 'KW-006',
    title: 'Grind Labs Burr X2 Electric Grinder',
    description: 'Electric burr grinder with 40 grind settings from espresso to French press.',
    price_paise: 649900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-006/600/600',
    brand: 'Grind Labs',
    rating: { value: 4.8, count: 389 },
  },
  {
    id: 'moka-pot-3cup',
    sku: 'KW-007',
    title: 'Roastline Stovetop Moka Pot 3-Cup',
    description: 'Cast-aluminum stovetop moka pot for a classic, concentrated brew.',
    price_paise: 129900,
    currency: 'INR',
    availability: 'out_of_stock',
    image: 'https://picsum.photos/seed/kw-007/600/600',
    brand: 'Roastline',
    rating: { value: 4.2, count: 167 },
  },
  {
    id: 'moka-pot-6cup',
    sku: 'KW-008',
    title: 'Roastline Stovetop Moka Pot 6-Cup XL',
    description: 'Larger-format moka pot with a heat-safe bakelite handle and safety valve.',
    price_paise: 179900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-008/600/600',
    brand: 'Roastline',
    rating: { value: 4.3, count: 144 },
  },
  {
    id: 'milk-frother',
    sku: 'KW-009',
    title: 'BrewCraft Handheld Milk Foam Wand',
    description: 'Battery-powered frothing wand for lattes and cappuccinos at the counter.',
    price_paise: 59900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-009/600/600',
    brand: 'BrewCraft',
    rating: { value: 4.1, count: 612 },
  },
  {
    id: 'coffee-scale',
    sku: 'KW-010',
    title: 'Grind Labs Precision Coffee Scale',
    description: 'Digital brew scale with built-in timer, accurate to 0.1g.',
    price_paise: 189900,
    currency: 'INR',
    availability: 'out_of_stock',
    image: 'https://picsum.photos/seed/kw-010/600/600',
    brand: 'Grind Labs',
    rating: { value: 4.5, count: 233 },
  },
  {
    id: 'cold-brew-maker',
    sku: 'KW-011',
    title: 'Roastline Cold Drip Tower 1.5L',
    description: 'Slow cold-drip tower for a low-acid concentrate brewed over several hours.',
    price_paise: 249900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-011/600/600',
    brand: 'Roastline',
    rating: { value: 4.6, count: 98 },
  },
  {
    id: 'espresso-tamper',
    sku: 'KW-012',
    title: 'CopperPour Tamper Pro 58mm',
    description: 'Flat-base 58mm tamper with a calibrated spring for consistent puck pressure.',
    price_paise: 119900,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://picsum.photos/seed/kw-012/600/600',
    brand: 'CopperPour',
    rating: { value: 4.7, count: 205 },
  },
]
