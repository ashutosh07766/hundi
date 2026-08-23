/**
 * Synthetic product data for the demo storefront. Hardcoded and deterministic
 * on purpose — this store exists to be read by AI buyer agents, not to model
 * real inventory, so the catalog never touches a database.
 */

export type Availability = 'in_stock' | 'out_of_stock'

export type Product = {
  id: string
  title: string
  description: string
  /** Integer price in paise (1/100 rupee). Schema.org / ACP feeds want a
   * decimal-rupee string instead — conversion happens at the API boundary,
   * never here, so this array stays the single source of truth. */
  price_paise: number
  currency: 'INR'
  availability: Availability
  image: string
  brand: string
}

export const MERCHANT_ID = 'demo-store-1'

export const catalog: readonly Product[] = [
  {
    id: 'sku-001',
    title: 'Velocity Air Runner',
    description:
      'Lightweight everyday trainer with responsive foam cushioning and a breathable mesh upper.',
    price_paise: 320000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-001',
    brand: 'Velocity Run',
  },
  {
    id: 'sku-002',
    title: 'Velocity Air Runner Pro',
    description:
      'Race-day update to the Air Runner with a carbon plate and a firmer, more propulsive ride.',
    price_paise: 450000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-002',
    brand: 'Velocity Run',
  },
  {
    id: 'sku-003',
    title: 'Velocity Cloudstep',
    description: 'Max-cushioned recovery shoe designed for easy miles and long standing days.',
    price_paise: 380000,
    currency: 'INR',
    availability: 'out_of_stock',
    image: '/img/sku-003',
    brand: 'Velocity Run',
  },
  {
    id: 'sku-004',
    title: 'Velocity Featherlite',
    description:
      'Sub-200g trainer built for speedwork, with a snug knit upper and low-profile outsole.',
    price_paise: 295000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-004',
    brand: 'Velocity Run',
  },
  {
    id: 'sku-005',
    title: 'TrailForge Ridge',
    description:
      'All-terrain trail shoe with a rock plate and multidirectional lugs for loose ground.',
    price_paise: 520000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-005',
    brand: 'TrailForge',
  },
  {
    id: 'sku-006',
    title: 'TrailForge Summit',
    description: 'High-mileage trail trainer with a reinforced toe cap and waterproof upper.',
    price_paise: 610000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-006',
    brand: 'TrailForge',
  },
  {
    id: 'sku-007',
    title: 'TrailForge Grip X',
    description: 'Sticky-rubber outsole tuned for wet rock and technical scrambles.',
    price_paise: 480000,
    currency: 'INR',
    availability: 'out_of_stock',
    image: '/img/sku-007',
    brand: 'TrailForge',
  },
  {
    id: 'sku-008',
    title: 'TrailForge Storm',
    description:
      'Weather-sealed trail runner with a gaiter-ready collar and aggressive lug pattern.',
    price_paise: 555000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-008',
    brand: 'TrailForge',
  },
  {
    id: 'sku-009',
    title: 'Pace Collective Sprint',
    description: 'Track-and-tempo shoe with a snappy midsole for short, fast intervals.',
    price_paise: 340000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-009',
    brand: 'Pace Collective',
  },
  {
    id: 'sku-010',
    title: 'Pace Collective Marathon',
    description: 'Distance trainer balancing cushioning and rebound for 20+ km runs.',
    price_paise: 410000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-010',
    brand: 'Pace Collective',
  },
  {
    id: 'sku-011',
    title: 'Pace Collective Tempo',
    description: 'Everyday trainer with a firmer midsole tuned for steady tempo runs.',
    price_paise: 365000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-011',
    brand: 'Pace Collective',
  },
  {
    id: 'sku-012',
    title: 'Pace Collective Interval',
    description: 'Lightweight trainer built for track workouts and short, sharp interval sessions.',
    price_paise: 395000,
    currency: 'INR',
    availability: 'out_of_stock',
    image: '/img/sku-012',
    brand: 'Pace Collective',
  },
  {
    id: 'sku-013',
    title: 'Stride Labs Motion+',
    description: 'Stability trainer with a medial post for runners who need extra support.',
    price_paise: 470000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-013',
    brand: 'Stride Labs',
  },
  {
    id: 'sku-014',
    title: 'Stride Labs ReactFoam',
    description: 'Nitrogen-infused foam midsole for a soft landing and energetic toe-off.',
    price_paise: 505000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-014',
    brand: 'Stride Labs',
  },
  {
    id: 'sku-015',
    title: 'Stride Labs Glide',
    description: 'Smooth-riding daily trainer with a rocker geometry for effortless transitions.',
    price_paise: 425000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-015',
    brand: 'Stride Labs',
  },
  {
    id: 'sku-016',
    title: 'Stride Labs UltraKnit',
    description: 'Sock-fit knit upper wrapped around a plush, cushioned platform.',
    price_paise: 585000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-016',
    brand: 'Stride Labs',
  },
  {
    id: 'sku-017',
    title: 'Apex Motion Ignite',
    description: 'Propulsive daily trainer with a dual-density midsole for pop on every stride.',
    price_paise: 630000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-017',
    brand: 'Apex Motion',
  },
  {
    id: 'sku-018',
    title: 'Apex Motion Zenith',
    description: 'Flagship cushioned trainer with the brand’s softest, most protective ride.',
    price_paise: 715000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-018',
    brand: 'Apex Motion',
  },
  {
    id: 'sku-019',
    title: 'Apex Motion Horizon',
    description: 'Versatile trainer built to handle everything from easy runs to tempo work.',
    price_paise: 495000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-019',
    brand: 'Apex Motion',
  },
  {
    id: 'sku-020',
    title: 'Apex Motion Nimbus',
    description: 'Ultra-max cushioned long-run shoe with a full-length carbon plate.',
    price_paise: 850000,
    currency: 'INR',
    availability: 'in_stock',
    image: '/img/sku-020',
    brand: 'Apex Motion',
  },
]
