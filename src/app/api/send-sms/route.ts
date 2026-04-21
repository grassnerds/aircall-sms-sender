import { createClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { to, body, numberId, apiId, apiToken } = await request.json()

  if (!to || !body || !numberId || !apiId || !apiToken) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const basicAuth = Buffer.from(`${apiId}:${apiToken}`).toString('base64')

  try {
    const res = await fetch(`https://api.aircall.io/v1/numbers/${numberId}/messages/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to, body }),
    })

    const data = await res.text()

    if (res.ok) {
      return NextResponse.json({ success: true, data })
    } else {
      return NextResponse.json({ error: data, status: res.status }, { status: res.status })
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
