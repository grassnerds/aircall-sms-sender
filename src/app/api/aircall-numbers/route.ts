import { createClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { apiId, apiToken } = await request.json()

  if (!apiId || !apiToken) {
    return NextResponse.json({ error: 'Missing API ID or API Token' }, { status: 400 })
  }

  const basicAuth = Buffer.from(`${apiId}:${apiToken}`).toString('base64')

  try {
    const res = await fetch('https://api.aircall.io/v1/numbers?per_page=50', {
      headers: { 'Authorization': `Basic ${basicAuth}` },
    })

    if (!res.ok) {
      return NextResponse.json({ error: 'Aircall API error: ' + res.status }, { status: res.status })
    }

    const data = await res.json()
    const numbers = (data.numbers || []).map((n: { id: number; name: string; digits: string }) => ({
      id: n.id,
      name: n.name,
      digits: n.digits,
    }))

    return NextResponse.json({ numbers })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
