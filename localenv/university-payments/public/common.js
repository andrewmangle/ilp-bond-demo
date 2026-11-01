// Shared by both pages: the API helper, amount formatting and the "acting as" role switch.
// The role is a demo stand-in for logging in; the server checks it on every request.

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fmt = (a) =>
  a ? `${(Number(a.value) / 10 ** a.assetScale).toLocaleString(undefined, { minimumFractionDigits: a.assetScale, maximumFractionDigits: a.assetScale })} ${a.assetCode}` : '—'
const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

const ROLE_KEY = 'university-payments.actingAs'
const roleState = { value: '', nodes: [], directory: [] }

function storedRole() {
  try { return localStorage.getItem(ROLE_KEY) || '' } catch { return '' }
}
function storeRole(value) {
  try { localStorage.setItem(ROLE_KEY, value) } catch {}
}

// { kind: 'bank', node } | { kind: 'student', node, accountId, account } | { kind: 'none' }
function currentRole() {
  const [kind, node, accountId] = roleState.value.split(':')
  if (kind === 'bank') return { kind, node }
  if (kind === 'student') {
    return { kind, node, accountId, account: roleState.directory.find((a) => a.node === node && a.id === accountId) }
  }
  return { kind: 'none' }
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-acting-as': roleState.value },
    body: body && JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({ error: `Request failed (${res.status})` }))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

function message(el, text, kind = 'err') { el.innerHTML = text ? `<div class="msg ${kind}">${text}</div>` : '' }

function busy(button, on, label) {
  if (!button.dataset.label) button.dataset.label = button.textContent
  button.disabled = on
  button.textContent = on ? label : button.dataset.label
}

function renderRoleBar(active) {
  const bar = $('rolebar')
  const options = [
    `<optgroup label="Central banks">${roleState.nodes.map((n) => `<option value="bank:${n.key}">${esc(n.bankName)}</option>`).join('')}</optgroup>`,
    ...roleState.nodes.map((n) => {
      const students = roleState.directory.filter((a) => a.node === n.key)
      return `<optgroup label="Students · ${esc(n.label)}">${students.map((a) => `<option value="student:${a.node}:${a.id}">student ${esc(a.name)} (${a.assetCode})</option>`).join('')}</optgroup>`
    })
  ]
  bar.className = `rolebar ${currentRole().kind === 'bank' ? 'bank' : ''}`
  bar.innerHTML = `<div class="inner">
      <nav><a href="/" class="${active === 'students' ? 'active' : ''}">Students</a><a href="/bonds" class="${active === 'bonds' ? 'active' : ''}">Bond Market</a><a href="/central-bank" class="${active === 'bank' ? 'active' : ''}">Central Bank</a><a href="/live" class="${active === 'live' ? 'active' : ''}">Live</a><a href="/control" class="${active === 'control' ? 'active' : ''}">Control</a></nav>
      <span class="clock" id="demo-day" title="Demo clock">${esc(clockText())}</span>
      <label class="role"><span>Acting as</span><select id="role-select">${options.join('')}</select></label>
    </div>`
  $('role-select').value = roleState.value
  $('role-select').addEventListener('change', (e) => setRole(e.target.value))
}

// Demo clock: bond time runs faster than real time; every page shows the demo day
let demoClock = null
const speedText = (s) => (s === 86400 ? 'real time' : s >= 3600 ? `1 day = ${s / 3600} h` : s >= 60 ? `1 day = ${s / 60} min` : `1 day = ${s} s`)
const clockText = () => (demoClock ? `Day ${demoClock.day} · ${demoClock.paused ? 'paused' : speedText(demoClock.secondsPerDay)}` : 'Day …')
async function refreshClock() {
  try {
    demoClock = await api('GET', '/api/clock')
    if ($('demo-day')) {
      $('demo-day').textContent = clockText()
      $('demo-day').classList.toggle('paused', demoClock.paused)
    }
  } catch {}
}
setInterval(refreshClock, 3000)

let onRoleChange = () => {}
let activePage = ''

function setRole(value) {
  roleState.value = value
  storeRole(value)
  renderRoleBar(activePage)
  onRoleChange(currentRole())
}

async function refreshDirectory() {
  roleState.directory = await api('GET', '/api/directory')
  const role = currentRole()
  // The stored student may be gone (mock banks forget created accounts when they restart)
  if (role.kind === 'student' && !role.account) roleState.value = `bank:${role.node}`
  renderRoleBar(activePage)
}

// Call once per page; `changed` runs now and after every role switch
async function initRoles(page, changed) {
  activePage = page
  onRoleChange = changed
  roleState.nodes = await api('GET', '/api/nodes')
  await refreshClock()
  roleState.value = storedRole() || `bank:${roleState.nodes[0].key}`
  await refreshDirectory().catch((err) => { roleState.directory = []; console.error(err) })
  if (![...$('role-select').options].some((o) => o.value === roleState.value)) roleState.value = `bank:${roleState.nodes[0].key}`
  setRole(roleState.value)
}
