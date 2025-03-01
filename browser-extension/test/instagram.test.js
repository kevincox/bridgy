'use strict'

import fetchMock from 'jest-fetch-mock'

import {
  forward,
  poll,
  injectGlobals,
  INSTAGRAM_BASE_URL,
  BRIDGY_BASE_URL,
} from '../instagram.js'

const postActivities = [{
  id: '246',
  object: {
    ig_shortcode: 'abc',
    replies: {totalItems: 3},
    ig_like_count: 5,
  },
}, {
  id: '357',
  object: {
    ig_shortcode: 'xyz',
    replies: {totalItems: 0},
    ig_like_count: 0,
  },
}]

fetchMock.enableMocks()

beforeAll(() => {
  injectGlobals({
    // browser is a namespace, so we can't use jest.mock(), have to mock and inject
    // it manually like this.
    browser: {
      contextualIdentities: {
        query: async (q) => []
      },
      cookies: {
        getAll: jest.fn(),
        getAllCookieStores: async () => [{id: 1}]
      },
      storage: {
        sync: {
          get: async () => browser.storage.sync.data,
          set: async values => Object.assign(browser.storage.sync.data, values),
          data: {},
        },
      },
    },
    console: {
      debug: () => null,
      log: () => null,
      error: () => null,
    },
    _console: console,
  })
})

beforeEach(() => {
  fetch.resetMocks()
  browser.cookies.getAll.mockResolvedValue([
    {name: 'sessionid', value: 'foo'},
    {name: 'bar', value: 'baz'},
  ])
  browser.storage.sync.data = {
    token: 'towkin',
  }
})

afterEach(() => {
  jest.restoreAllMocks()
})


test('forward', async () => {
  fetch.mockResponseOnce('ig resp')
  fetch.mockResponseOnce('"bridgy resp"')

  expect(await forward('/ig-path', '/br-path')).toBe('bridgy resp')

  expect(fetch.mock.calls.length).toBe(2)
  expect(fetch.mock.calls[0]).toEqual([
    `${INSTAGRAM_BASE_URL}/ig-path`,
    {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        'Cookie': 'sessionid=foo; bar=baz',
        'User-Agent': navigator.userAgent,
      },
    },
  ])
  expect(fetch.mock.calls[1]).toEqual([
    `${BRIDGY_BASE_URL}/br-path`,
    {
      method: 'POST',
      body: 'ig resp',
    },
  ])
})

test('forward, non-JSON response from Bridgy', async () => {
  fetch.mockResponseOnce('ig resp')
  fetch.mockResponseOnce('')  // not valid JSON
  expect(await forward('/ig-path', '/br-path')).toBeNull()
})

test('poll, no stored token', async () => {
  // no token stored
  browser.storage.sync.data = {}
  await poll()

  expect(fetch.mock.calls.length).toBe(0)
  expect(browser.storage.sync.data.instagramLastStart).toBeUndefined()
  expect(browser.storage.sync.data.instagramLastSuccess).toBeUndefined()
})

test('poll, no stored username', async () => {
  // no username stored
  expect(browser.storage.sync.data.instagramUsername).toBeUndefined()

  fetch.mockResponseOnce('ig home page')
  fetch.mockResponseOnce('"snarfed"')
  fetch.mockResponseOnce('ig profile')
  fetch.mockResponseOnce(JSON.stringify(postActivities))
  fetch.mockResponseOnce('post abc')
  fetch.mockResponseOnce('{}')
  fetch.mockResponseOnce('likes abc')
  fetch.mockResponseOnce('{}')
  fetch.mockResponseOnce('post xyz')
  fetch.mockResponseOnce('{}')
  fetch.mockResponseOnce('likes xyz')
  fetch.mockResponseOnce('{}')
  fetch.mockResponseOnce('"OK"')

  await poll()
  expect(fetch.mock.calls.length).toBe(13)

  expect(fetch.mock.calls[0][0]).toBe(`${INSTAGRAM_BASE_URL}/`)
  expect(fetch.mock.calls[1][0]).toBe(`${BRIDGY_BASE_URL}/homepage`)

  expect(await browser.storage.sync.get()).toMatchObject({
    instagramUsername: 'snarfed',
    'instagramPost-abc': {c: 3, l: 5},
    'instagramPost-xyz': {c: 0, l: 0},
  })

  expect(fetch.mock.calls[2][0]).toBe(`${INSTAGRAM_BASE_URL}/snarfed/`)
  expect(fetch.mock.calls[3][0]).toBe(`${BRIDGY_BASE_URL}/profile?token=towkin`)
  expect(fetch.mock.calls[3][1].body).toBe('ig profile')

  for (const [i, shortcode, id] of [[4, 'abc', '246'], [8, 'xyz', '357']]) {
    expect(fetch.mock.calls[i][0]).toBe(`${INSTAGRAM_BASE_URL}/p/${shortcode}/`)
    expect(fetch.mock.calls[i + 1][0]).toBe(`${BRIDGY_BASE_URL}/post?token=towkin`)
    expect(fetch.mock.calls[i + 1][1].body).toBe(`post ${shortcode}`)
    expect(fetch.mock.calls[i + 2][0]).toContain(`${INSTAGRAM_BASE_URL}/graphql/`)
    expect(fetch.mock.calls[i + 2][0]).toContain(shortcode)
    expect(fetch.mock.calls[i + 3][0]).toBe(`${BRIDGY_BASE_URL}/likes?id=${id}&token=towkin`)
    expect(fetch.mock.calls[i + 3][1].body).toBe(`likes ${shortcode}`)
  }

  expect(fetch.mock.calls[12][0]).toBe(`${BRIDGY_BASE_URL}/poll?username=snarfed`)

  // this will be NaN if either value is undefined
  expect(browser.storage.sync.data.instagramLastSuccess -
         browser.storage.sync.data.instagramLastStart).toBeLessThan(2000) // ms
})

test('poll, skip comments and likes', async () => {
  fetch.mockResponseOnce('{}')
  fetch.mockResponseOnce(JSON.stringify(postActivities))
  fetch.mockResponseOnce('post xyz')
  fetch.mockResponseOnce('{}')
  fetch.mockResponseOnce('likes xyz')
  fetch.mockResponseOnce('{}')
  fetch.mockResponseOnce('{}')

  await browser.storage.sync.set({
    instagramUsername: 'snarfed',
    'instagramPost-abc': {c: 3, l: 5},
  })

  await poll()
  expect(fetch.mock.calls.length).toBe(7)
  expect(fetch.mock.calls[0][0]).toBe(`${INSTAGRAM_BASE_URL}/snarfed/`)
  expect(fetch.mock.calls[2][0]).toBe(`${INSTAGRAM_BASE_URL}/p/xyz/`)

  expect(await browser.storage.sync.get()).toMatchObject({
    instagramUsername: 'snarfed',
    'instagramPost-abc': {c: 3, l: 5},
    'instagramPost-xyz': {c: 0, l: 0},
  })

  // this will be NaN if either value is undefined
  expect(browser.storage.sync.data.instagramLastSuccess -
         browser.storage.sync.data.instagramLastStart).toBeLessThan(2000) // ms
})

test('poll, existing username stored', async () => {
  await browser.storage.sync.set({instagramUsername: 'snarfed'})
  await poll()
  expect(fetch.mock.calls[0][0]).toBe(`${INSTAGRAM_BASE_URL}/snarfed/`)
})

test('poll, profile error', async () => {
  fetch.mockResponseOnce('ig profile')
  fetch.mockResponseOnce('{}', {status: 400})  // Bridgy returns an HTTP error

  await browser.storage.sync.set({instagramUsername: 'snarfed'})
  await poll()

  expect(fetch.mock.calls.length).toBe(2)
  expect(browser.storage.sync.data.instagramLastStart).toBeDefined()
  expect(browser.storage.sync.data.instagramLastSuccess).toBeUndefined()
})

test('poll, Bridgy non-JSON response', async () => {
  fetch.mockResponseOnce('ig profile')
  fetch.mockResponseOnce('xyz')  // Bridgy returns invalid JSON

  await browser.storage.sync.set({instagramUsername: 'snarfed'})
  await poll()

  expect(fetch.mock.calls.length).toBe(2)
  expect(browser.storage.sync.data.instagramLastStart).toBeDefined()
  expect(browser.storage.sync.data.instagramLastSuccess).toBeUndefined()
})
