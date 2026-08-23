import { describe, expect, it } from 'vitest'
import { isPrivateOrLoopbackIp } from '../ip-guard.js'

describe('isPrivateOrLoopbackIp', () => {
  const privateAddresses = [
    '127.0.0.1',
    '127.8.8.8',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata endpoint
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fd00::abcd',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.5',
    'not-an-ip',
  ]

  const publicAddresses = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255', // just below the 172.16/12 private band
    '172.32.0.1', // just above the 172.16/12 private band
    '2606:4700:4700::1111', // Cloudflare public DNS
    '2001:4860:4860::8888', // Google public DNS
  ]

  it.each(privateAddresses)('flags %s as private/loopback', (address) => {
    expect(isPrivateOrLoopbackIp(address)).toBe(true)
  })

  it.each(publicAddresses)('allows %s as public', (address) => {
    expect(isPrivateOrLoopbackIp(address)).toBe(false)
  })
})
