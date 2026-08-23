export type {
  CatalogAdapter,
  CatalogAdapterRow,
  HundiManifest,
} from './generators.js'
export { generateCatalogAdapter, generateLlmsTxt, generateManifest } from './generators.js'
export { isPrivateOrLoopbackIp } from './ip-guard.js'
export type { RegisterMerchantArgs, RegisterMerchantResult } from './register.js'
export { registerMerchant } from './register.js'
export type {
  Availability,
  ResolvedAddress,
  Resolver,
  SafeFetchOptions,
  SafeFetchResult,
  ScannedProduct,
  ScanOptions,
  ScanResult,
} from './scanner.js'
export { extractLinks, extractProducts, ScanError, safeFetch, scanStore } from './scanner.js'
