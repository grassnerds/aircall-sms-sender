'use client'

import { createClient } from '@/lib/supabase-browser'
import { useEffect, useState, useRef, useCallback } from 'react'
import * as XLSX from 'xlsx'

interface Contact {
  row: number
  name: string
  phone: string
  message: string
  status: 'Pending' | 'Sending' | 'Sent' | 'Failed'
  selected: boolean
  error?: string
}

interface AircallNumber {
  id: number
  name: string
  digits: string
}

export default function Home() {
  const supabase = createClient()
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null)

  // Settings
  const [apiToken, setApiToken] = useState('')
  const [numberId, setNumberId] = useState('')
  const [delayMs, setDelayMs] = useState(1200)
  const [aircallNumbers, setAircallNumbers] = useState<AircallNumber[]>([])
  const [fetchingNumbers, setFetchingNumbers] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  // Contacts
  const [contacts, setContacts] = useState<Contact[]>([])
  const [templates, setTemplates] = useState<Record<string, string>>({})
  const [fileName, setFileName] = useState('')

  // Sending state
  const [sending, setSending] = useState(false)
  const stopRef = useRef(false)
  const [sentCount, setSentCount] = useState(0)
  const [failCount, setFailCount] = useState(0)
  const [logs, setLogs] = useState<{ msg: string; type: string }[]>([])
  const [showLog, setShowLog] = useState(false)

  // Load user + settings
  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { window.location.href = '/login'; return }
      setUser(user)

      const { data } = await supabase
        .from('settings')
        .select('*')
        .eq('user_id', user.id)
        .single()

      if (data) {
        setApiToken(data.aircall_token || '')
        setNumberId(data.number_id || '')
        setDelayMs(data.delay_ms || 1200)
      }
      setSettingsLoaded(true)
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Save settings
  const saveSettings = useCallback(async () => {
    if (!user) return
    await supabase.from('settings').upsert({
      user_id: user.id,
      aircall_token: apiToken,
      number_id: numberId,
      delay_ms: delayMs,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
  }, [user, apiToken, numberId, delayMs, supabase])

  // Auto-save settings when they change
  useEffect(() => {
    if (!settingsLoaded || !user) return
    const t = setTimeout(() => saveSettings(), 1000)
    return () => clearTimeout(t)
  }, [apiToken, numberId, delayMs, settingsLoaded, user, saveSettings])

  // Fetch Aircall numbers
  async function fetchNumbers() {
    if (!apiToken) return alert('Enter your API token first.')
    setFetchingNumbers(true)
    try {
      const res = await fetch('/api/aircall-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken }),
      })
      const data = await res.json()
      if (data.numbers) setAircallNumbers(data.numbers)
      else alert('Error: ' + (data.error || 'Unknown'))
    } catch (e) {
      alert('Failed to fetch numbers: ' + (e instanceof Error ? e.message : ''))
    }
    setFetchingNumbers(false)
  }

  // File upload
  function handleFile(file: File) {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'array' })
        const tmpls: Record<string, string> = {}
        if (wb.SheetNames.includes('Templates')) {
          const tRows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['Templates'])
          tRows.forEach(r => {
            if (r['Template Name'] && r['Message Text']) tmpls[r['Template Name']] = r['Message Text']
          })
        }
        setTemplates(tmpls)

        const sheetName = wb.SheetNames.includes('Contacts') ? 'Contacts' : wb.SheetNames[0]
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName])
        const parsed: Contact[] = []

        rows.forEach((r, i) => {
          const name = String(r['Name'] || r['name'] || '').trim()
          const phone = String(r['Phone Number'] || r['phone'] || r['Phone'] || r['phone_number'] || '').trim()
          const msgType = String(r['Message Type'] || r['message_type'] || '')
          const customMsg = String(r['Custom Message'] || r['custom_message'] || '')
          const directMsg = String(r['Message'] || r['message'] || r['Body'] || r['body'] || r['Text'] || r['text'] || '')

          if (!name || !phone) return

          let message = ''
          if (directMsg) message = directMsg
          else if (msgType === 'Custom' && customMsg) message = customMsg
          else if (msgType && tmpls[msgType]) message = tmpls[msgType].replace(/\{name\}/gi, name)
          else if (customMsg) message = customMsg
          else if (Object.keys(tmpls).length === 1) message = Object.values(tmpls)[0].replace(/\{name\}/gi, name)

          if (!message) return

          parsed.push({
            row: i + 2,
            name,
            phone: phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, ''),
            message,
            status: 'Pending',
            selected: true,
          })
        })

        setContacts(parsed)
        setFileName(file.name)
        setSentCount(0)
        setFailCount(0)
        setLogs([])
      } catch (err) {
        alert('Error reading file: ' + (err instanceof Error ? err.message : ''))
      }
    }
    reader.readAsArrayBuffer(file)
  }

  function toggleAll(checked: boolean) {
    setContacts(prev => prev.map(c => ({ ...c, selected: checked })))
  }

  const selectedCount = contacts.filter(c => c.selected).length

  // Send messages
  async function startSending() {
    if (!apiToken || !numberId) return alert('Configure API token and number ID first.')
    const toSend = contacts.filter(c => c.selected && c.status === 'Pending')
    if (!toSend.length) return alert('No pending contacts selected.')
    if (!confirm(`Send ${toSend.length} message(s) via Aircall?`)) return

    setSending(true)
    stopRef.current = false
    let sent = 0, failed = 0

    for (const c of toSend) {
      if (stopRef.current) { addLog('Stopped by user.', 'info'); break }

      const idx = contacts.indexOf(c)
      updateContact(idx, { status: 'Sending' })

      try {
        const res = await fetch('/api/send-sms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: c.phone, body: c.message, numberId, apiToken }),
        })

        if (res.ok) {
          updateContact(idx, { status: 'Sent' })
          sent++
          addLog(`Sent to ${c.name} (${c.phone})`, 'success')
        } else {
          const err = await res.text()
          updateContact(idx, { status: 'Failed', error: err })
          failed++
          addLog(`Failed: ${c.name} — ${res.status} ${err}`, 'error')
        }
      } catch (err) {
        updateContact(idx, { status: 'Failed', error: String(err) })
        failed++
        addLog(`Error: ${c.name} — ${err instanceof Error ? err.message : ''}`, 'error')
      }

      setSentCount(sent)
      setFailCount(failed)

      if (!stopRef.current) await new Promise(r => setTimeout(r, Math.max(500, delayMs)))
    }

    setSending(false)
    addLog(`Done! ${sent} sent, ${failed} failed.`, 'info')
  }

  function updateContact(idx: number, updates: Partial<Contact>) {
    setContacts(prev => prev.map((c, i) => i === idx ? { ...c, ...updates } : c))
  }

  function addLog(msg: string, type: string) {
    setLogs(prev => [...prev, { msg: `[${new Date().toLocaleTimeString()}] ${msg}`, type }])
  }

  // Download results
  function downloadResults() {
    const rows = contacts.map(c => ({
      Name: c.name, 'Phone Number': c.phone, Message: c.message, Status: c.status,
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Results')
    XLSX.writeFile(wb, 'Aircall_SMS_Results.xlsx')
  }

  // Sign out
  async function signOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const progress = contacts.length > 0 ? ((sentCount + failCount) / contacts.filter(c => c.selected).length) * 100 : 0

  if (!settingsLoaded) {
    return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><p className="text-gray-400">Loading...</p></div>
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-gradient-to-r from-emerald-500 to-teal-600 text-white px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-white/15 rounded-xl flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 40 40" fill="none">
              <path d="M12 14h16v2H12zM12 19h12v2H12zM12 24h8v2H12zM26 22l4 4-4 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-semibold">Aircall SMS Sender</h1>
            <p className="text-sm text-white/80">Upload contacts, preview, and send</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-white/70">{user?.email}</span>
          <button onClick={signOut} className="text-sm bg-white/15 hover:bg-white/25 px-3 py-1.5 rounded-lg transition">Sign out</button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto p-6 space-y-5">

        {/* Step 1: Config */}
        <section className="bg-white rounded-xl border p-6">
          <h2 className="font-semibold flex items-center gap-2 mb-4">
            <span className="w-7 h-7 bg-emerald-500 text-white rounded-full flex items-center justify-center text-sm font-bold">1</span>
            API Configuration
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">Aircall API Token</label>
              <input type="password" value={apiToken} onChange={e => setApiToken(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none text-sm" placeholder="Bearer token" />
              <p className="text-xs text-gray-400 mt-1">Aircall Dashboard &rarr; Integrations &rarr; API Keys</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">Sending Number ID</label>
              <input type="text" value={numberId} onChange={e => setNumberId(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none text-sm" placeholder="e.g. 123456" />
              <button onClick={fetchNumbers} disabled={fetchingNumbers} className="text-xs text-emerald-600 hover:underline mt-1">
                {fetchingNumbers ? 'Fetching...' : 'Fetch my numbers'}
              </button>
            </div>
          </div>

          {aircallNumbers.length > 0 && (
            <div className="mt-3 flex items-center gap-2">
              <select value={numberId} onChange={e => setNumberId(e.target.value)}
                className="flex-1 px-3 py-2 border rounded-lg text-sm">
                {aircallNumbers.map(n => <option key={n.id} value={n.id}>{n.name} ({n.digits}) — ID: {n.id}</option>)}
              </select>
            </div>
          )}

          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-600 mb-1">Delay between messages (ms)</label>
            <input type="number" value={delayMs} onChange={e => setDelayMs(parseInt(e.target.value) || 1200)} min={500} max={10000}
              className="w-32 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none" />
            <p className="text-xs text-gray-400 mt-1">Aircall allows 60 req/min. 1200ms is safe.</p>
          </div>
          <p className="text-xs text-emerald-600 mt-2">Settings auto-save to your account.</p>
        </section>

        {/* Step 2: Upload */}
        <section className="bg-white rounded-xl border p-6">
          <h2 className="font-semibold flex items-center gap-2 mb-4">
            <span className="w-7 h-7 bg-emerald-500 text-white rounded-full flex items-center justify-center text-sm font-bold">2</span>
            Upload Contact List
          </h2>
          <div
            onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-emerald-500', 'bg-emerald-50') }}
            onDragLeave={e => { e.currentTarget.classList.remove('border-emerald-500', 'bg-emerald-50') }}
            onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('border-emerald-500', 'bg-emerald-50'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]) }}
            onClick={() => document.getElementById('fileInput')?.click()}
            className="border-2 border-dashed border-gray-300 rounded-xl p-10 text-center cursor-pointer hover:border-emerald-500 hover:bg-emerald-50 transition"
          >
            <p className="text-3xl mb-2">📦</p>
            <p className="text-gray-600"><strong>Drag &amp; drop</strong> your spreadsheet, or <strong>click to browse</strong></p>
            <p className="text-xs text-gray-400 mt-1">.xlsx, .xls, .csv</p>
          </div>
          <input type="file" id="fileInput" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]) }} />
          {fileName && (
            <div className="mt-3 bg-emerald-50 text-emerald-800 text-sm rounded-lg px-4 py-2">
              <strong>{fileName}</strong> — {contacts.length} contacts loaded
              {Object.keys(templates).length > 0 && `, ${Object.keys(templates).length} template(s)`}
            </div>
          )}
        </section>

        {/* Step 3: Preview & Send */}
        {contacts.length > 0 && (
          <section className="bg-white rounded-xl border p-6">
            <h2 className="font-semibold flex items-center gap-2 mb-4">
              <span className="w-7 h-7 bg-emerald-500 text-white rounded-full flex items-center justify-center text-sm font-bold">3</span>
              Preview &amp; Send
            </h2>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="px-3 py-2 text-left">
                      <input type="checkbox" checked={contacts.every(c => c.selected)} onChange={e => toggleAll(e.target.checked)} className="accent-emerald-500" />
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">#</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Name</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Phone</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Message</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c, i) => (
                    <tr key={i} className="border-t hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={c.selected}
                          onChange={() => setContacts(prev => prev.map((x, j) => j === i ? { ...x, selected: !x.selected } : x))}
                          className="accent-emerald-500" />
                      </td>
                      <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2 text-gray-600">{c.phone}</td>
                      <td className="px-3 py-2 text-gray-600 max-w-xs truncate" title={c.message}>{c.message}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                          c.status === 'Sent' ? 'bg-green-100 text-green-700' :
                          c.status === 'Failed' ? 'bg-red-100 text-red-700' :
                          c.status === 'Sending' ? 'bg-blue-100 text-blue-700' :
                          'bg-orange-100 text-orange-700'
                        }`}>{c.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-3 mt-4 flex-wrap">
              <button onClick={startSending} disabled={sending || selectedCount === 0}
                className="px-5 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg font-medium transition disabled:opacity-50">
                {sending ? 'Sending...' : 'Send Messages'}
              </button>
              {sending && (
                <button onClick={() => { stopRef.current = true }} className="px-5 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium transition">
                  Stop
                </button>
              )}
              <button onClick={downloadResults} disabled={sentCount === 0 && failCount === 0}
                className="px-5 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition disabled:opacity-50">
                Download Results
              </button>
              <span className="text-sm text-gray-500">{selectedCount} of {contacts.length} selected</span>
            </div>

            {/* Progress */}
            {(sentCount > 0 || failCount > 0) && (
              <div className="mt-4">
                <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full transition-all" style={{ width: `${Math.min(progress, 100)}%` }} />
                </div>
                <div className="flex gap-6 mt-3">
                  <div className="text-center"><div className="text-2xl font-bold text-blue-600">{sentCount + failCount}</div><div className="text-xs text-gray-500">Total</div></div>
                  <div className="text-center"><div className="text-2xl font-bold text-green-600">{sentCount}</div><div className="text-xs text-gray-500">Sent</div></div>
                  <div className="text-center"><div className="text-2xl font-bold text-red-600">{failCount}</div><div className="text-xs text-gray-500">Failed</div></div>
                </div>
              </div>
            )}

            {/* Log */}
            {logs.length > 0 && (
              <div className="mt-4">
                <button onClick={() => setShowLog(!showLog)} className="text-sm text-gray-500 hover:text-gray-700">
                  {showLog ? 'Hide log' : 'Show log'}
                </button>
                {showLog && (
                  <div className="mt-2 bg-gray-900 text-green-300 font-mono text-xs p-3 rounded-lg max-h-48 overflow-y-auto">
                    {logs.map((l, i) => (
                      <p key={i} className={l.type === 'error' ? 'text-red-300' : l.type === 'success' ? 'text-green-300' : 'text-blue-300'}>{l.msg}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
