import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node'
import { json } from '@remix-run/node'
import { createHmac, timingSafeEqual } from 'crypto'
import { CONFIG as config } from '~/lib/parse_config.server'

export function loader({ request }: LoaderFunctionArgs) {
  const base = new URL(request.url).searchParams.get('base') || 'USD'

  return json(
    {
      base,
      rates: config.seed.rates[base] || {}
    },
    { status: 200 }
  )
}

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000

// Same signature scheme as the Rafiki admin API: `t=<ms>, v1=<hex hmac-sha256(secret, "<t>.<body>")>`
function isSignatureValid(header: string | null, body: string): boolean {
  const secret = process.env.SIGNATURE_SECRET
  if (!secret || !header) return false
  const parts = Object.fromEntries(
    header.split(',').map((part) => part.trim().split('=', 2))
  )
  const timestamp = Number(parts.t)
  if (!timestamp || Math.abs(Date.now() - timestamp) > MAX_SIGNATURE_AGE_MS) {
    return false
  }
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest()
  const given = Buffer.from(String(parts.v1 ?? ''), 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// Sets one currency's rate against USD (`{ "currency": "ZAR", "perUsd": 19 }`) in the rates this
// mock bank serves to its Rafiki backend, and derives the inverse and cross rates from it.
// Kept in memory only: a restart goes back to the rates in the seed file.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 })
  }
  const body = await request.text()
  if (!isSignatureValid(request.headers.get('signature'), body)) {
    return json({ error: 'Invalid signature' }, { status: 401 })
  }

  let currency: unknown, perUsd: unknown
  try {
    ;({ currency, perUsd } = JSON.parse(body))
  } catch {
    return json({ error: 'Body must be JSON' }, { status: 400 })
  }
  if (
    typeof currency !== 'string' ||
    !/^[A-Z]{3}$/.test(currency) ||
    currency === 'USD'
  ) {
    return json(
      { error: 'currency must be a 3-letter code other than USD' },
      { status: 400 }
    )
  }
  if (typeof perUsd !== 'number' || !Number.isFinite(perUsd) || perUsd <= 0) {
    return json(
      { error: 'perUsd must be a positive number' },
      { status: 400 }
    )
  }

  const rates = config.seed.rates
  rates.USD = rates.USD || {}
  rates.USD[currency] = perUsd
  rates[currency] = rates[currency] || {}
  rates[currency].USD = 1 / perUsd
  for (const [other, otherPerUsd] of Object.entries(rates.USD)) {
    if (other === currency) continue
    rates[currency][other] = otherPerUsd / perUsd
    rates[other] = rates[other] || {}
    rates[other][currency] = perUsd / otherPerUsd
  }

  return json({ currency, perUsd, rates }, { status: 200 })
}
