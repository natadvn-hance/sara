import { describe, expect, it } from 'vitest'
import { loadNodeConfig } from '../src/config'

describe('node config', () => {
  it('FR-ACC-1: each account comes with its own proxy and IP', () => {
    const c = loadNodeConfig({
      PROFI_ACCOUNTS: JSON.stringify([
        { id: 'hance-marketing', proxy: 'socks5://socks-ip1:1080', egressIp: '203.0.113.9' },
      ]),
    })
    expect(c.accounts).toEqual([
      { id: 'hance-marketing', proxy: 'socks5://socks-ip1:1080', egressIp: '203.0.113.9' },
    ])
    expect(c.profiBaseUrl).toBe('https://profi.ru')
  })

  it('NFR-SEC-1: in production the node token and permit secret are required', () => {
    expect(() => loadNodeConfig({ NODE_ENV: 'production', PROFI_ACCOUNTS: '[]' })).toThrow(
      /SARA_NODE_TOKEN/,
    )
  })

  it('FR-CONV-9: sending messages to clients is off unless SARA_NODE_SEND_MESSAGES is 1', () => {
    expect(loadNodeConfig({}).sendMessages).toBe(false)
    expect(loadNodeConfig({ SARA_NODE_SEND_MESSAGES: '' }).sendMessages).toBe(false)
    expect(loadNodeConfig({ SARA_NODE_SEND_MESSAGES: 'true' }).sendMessages).toBe(false)
    expect(loadNodeConfig({ SARA_NODE_SEND_MESSAGES: '1' }).sendMessages).toBe(true)
  })
})
