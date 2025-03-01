'use strict'

import './browser-polyfill.js'

import {INDIEAUTH_START} from './common.js'
import {
  findCookies,
  poll,
  postBridgy,
  BRIDGY_BASE_URL,
  INSTAGRAM_LOGIN_URL,
} from './instagram.js'

async function update() {
  console.debug('Updating options page UI')
  const data = await browser.storage.sync.get()

  if (data.instagramUsername) {
    document.querySelector('#username').innerText = data.instagramUsername
    document.querySelector('#username').href = `https://www.instagram.com/${data.instagramUsername}/`
    document.querySelector('#user-page').innerText = `brid.gy/instagram/${data.instagramUsername}`
    document.querySelector('#user-page').href = `https://brid.gy/instagram/${data.instagramUsername}`
  }

  if (data.instagramLastStart) {
    document.querySelector('#last-start').innerText = new Date(data.instagramLastStart).toLocaleString()
  }
  if (data.instagramLastSuccess) {
    document.querySelector('#last-success').innerText = new Date(data.instagramLastSuccess).toLocaleString()
  }

  const posts = Object.entries(data).filter(x => x[0].startsWith('instagramPost-'))
  const comments = posts.reduce((sum, cur) => sum + cur[1].c, 0)
  const likes = posts.reduce((sum, cur) => sum + cur[1].l, 0)
  document.querySelector('#posts').innerText = posts.length
  document.querySelector('#comments').innerText = comments
  document.querySelector('#likes').innerText = likes

  document.querySelector('#token').innerText = data.token

  const domains = await postBridgy(`/token-domains?token=${data.token}`)
  document.querySelector('#domains').innerText = (domains ? domains.join(', ') : 'none')

  const cookies = await findCookies()
  let status = document.querySelector('#status')
  if (!cookies) {
    status.innerHTML = `No Instagram cookie found. <a href="${LOGIN_URL}">Try logging in!</a>`
    status.className = 'pending'
  } else if (!domains) {
    status.innerText = `Not connected to Bridgy. <a href="${INDIEAUTH_START}?token=${token}">Connect now!</a>`
    status.className = 'pending'
  } else if (!data.instagramLastStart) {
    status.innerText = 'Not started yet'
    status.className = 'pending'
  } else if (!data.instagramLastSuccess) {
    status.innerText = 'Poll is failing'
    status.className = 'error'
  } else if (data.instagramLastStart > data.instagramLastSuccess) {
    status.innerText = 'Poll was working but is now failing'
    status.className = 'error'
  } else if (data.instagramLastSuccess >= data.instagramLastStart) {
    status.innerText = 'OK'
    status.className = 'ok'
  }
}

export {update}
