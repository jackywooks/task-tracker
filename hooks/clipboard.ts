// Rich-link clipboard: writes an HTML flavor and a plain-text flavor through the OS.
// Content (labels, urls) only ever travels as data (stdin, or hex literals), never as command text.

export type RunProcess = (
  argv: readonly string[],
  init?: { stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type LinkItem = { label: string; url: string; kind?: string; parent?: string }

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const anchor = (i: LinkItem): string => `<a href="${escapeHtml(i.url)}">${escapeHtml(i.label)}</a>`

export const richPayload = (items: LinkItem[], isList: boolean): { html: string; text: string } =>
  isList
    ? {
        html: `<ul>${items.map(i => `<li>${anchor(i)}</li>`).join('')}</ul>`,
        text: items.map(i => `${i.label} ${i.url}`).join('\n'),
      }
    : { html: anchor(items[0]), text: `${items[0].label} ${items[0].url}` }

// ---- Grouped Created links: Issues (numbered, sub-issues nested) -> PRs -> Other ----

export type GroupId = 'issues' | 'prs' | 'other'
export type GroupNode = { item: LinkItem; children: LinkItem[] }
export type LinkGroup = { id: GroupId; nodes: GroupNode[] }
export type GroupNames = Record<GroupId, string>

// kind wins; without a kind the url decides (/pull/ -> pr, /issues/ -> issue); anything else is Other
export const classify = (i: LinkItem): GroupId => {
  const k = (i.kind ?? '').trim().toLowerCase()
  if (k === 'pr' || k === 'pull' || k === 'pull request' || k === 'pull-request') return 'prs'
  if (k === 'issue' || k === 'epic') return 'issues'
  if (k !== '') return 'other'
  if (/\/pull\/\d+/.test(i.url)) return 'prs'
  if (/\/issues\/\d+/.test(i.url)) return 'issues'
  return 'other'
}

// Non-empty groups only. A child hangs under its parent only when the parent is a top-level issue in the list.
export const groupLinks = (items: LinkItem[]): LinkGroup[] => {
  const issues = items.filter(i => classify(i) === 'issues')
  const isNested = (i: LinkItem): boolean =>
    i.parent !== undefined &&
    i.parent !== i.url &&
    issues.some(p => p.url === i.parent && !(p.parent !== undefined && p.parent !== p.url && issues.some(q => q.url === p.parent)))
  const nodes: GroupNode[] = issues.filter(i => !isNested(i)).map(item => ({ item, children: [] }))
  for (const i of issues.filter(isNested)) nodes.find(n => n.item.url === i.parent)?.children.push(i)
  const out: LinkGroup[] = []
  if (nodes.length > 0) out.push({ id: 'issues', nodes })
  for (const id of ['prs', 'other'] as const) {
    const list = items.filter(i => classify(i) === id)
    if (list.length > 0) out.push({ id, nodes: list.map(item => ({ item, children: [] })) })
  }
  return out
}

const mdEscape = (s: string): string => s.replace(/[\\[\]]/g, c => '\\' + c)

export const mdLink = (i: LinkItem): string => `[${mdEscape(i.label)}](${i.url})`

export const singlePayload = (i: LinkItem): GroupedPayload => ({
  html: anchor(i),
  text: `${i.label} ${i.url}`,
  markdown: mdLink(i),
})

export type GroupedPayload = { html: string; text: string; markdown: string }

export const groupedPayload = (groups: LinkGroup[], names: GroupNames): GroupedPayload => {
  const html: string[] = []
  const text: string[] = []
  const md: string[] = []
  for (const g of groups) {
    html.push(`<p><b>${escapeHtml(names[g.id])}</b></p>`)
    text.push(names[g.id])
    md.push(`**${names[g.id]}**`)
    const link = mdLink
    if (g.id === 'issues') {
      html.push(
        '<ol>' +
          g.nodes
            .map(n => {
              const sub = n.children.length > 0 ? `<ol>${n.children.map(c => `<li>${anchor(c)}</li>`).join('')}</ol>` : ''
              return `<li>${anchor(n.item)}${sub}</li>`
            })
            .join('') +
          '</ol>',
      )
      g.nodes.forEach((n, a) => {
        text.push(`${a + 1}. ${n.item.label} ${n.item.url}`)
        md.push(`${a + 1}. ${link(n.item)}`)
        n.children.forEach((c, b) => {
          text.push(`   ${a + 1}.${b + 1} ${c.label} ${c.url}`)
          md.push(`   ${b + 1}. ${link(c)}`)
        })
      })
    } else {
      html.push(`<ul>${g.nodes.map(n => `<li>${anchor(n.item)}</li>`).join('')}</ul>`)
      for (const n of g.nodes) {
        text.push(`- ${n.item.label} ${n.item.url}`)
        md.push(`- ${link(n.item)}`)
      }
    }
    text.push('')
    md.push('')
  }
  text.pop()
  md.pop()
  return { html: html.join(''), text: text.join('\n'), markdown: md.join('\n') }
}

const toHex = (s: string): string =>
  Array.from(new TextEncoder().encode(s), b => b.toString(16).padStart(2, '0')).join('')

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64 = (bytes: number[]): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

// Fixed script: no interpolation of any content. It reads {html, text} JSON (ASCII only) from stdin.
const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$frag = [string]$j.html',
  '$text = [string]$j.text',
  '$enc = New-Object System.Text.UTF8Encoding($false)',
  '$nl = "`r`n"',
  "$tpl = 'Version:0.9{0}StartHTML:{1:D10}{0}EndHTML:{2:D10}{0}StartFragment:{3:D10}{0}EndFragment:{4:D10}{0}'",
  "$pre = '<html><body><!--StartFragment-->'",
  "$post = '<!--EndFragment--></body></html>'",
  '$hl = $enc.GetByteCount([string]::Format($tpl, $nl, 0, 0, 0, 0))',
  '$sf = $hl + $enc.GetByteCount($pre)',
  '$ef = $sf + $enc.GetByteCount($frag)',
  '$eh = $ef + $enc.GetByteCount($post)',
  '$cf = [string]::Format($tpl, $nl, $hl, $eh, $sf, $ef) + $pre + $frag + $post',
  '$d = New-Object System.Windows.Forms.DataObject',
  '$ms = New-Object System.IO.MemoryStream(, $enc.GetBytes($cf))',
  '$d.SetData([System.Windows.Forms.DataFormats]::Html, $ms)',
  '$d.SetText($text)',
  '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)',
].join('\n')

const asciiJson = (v: unknown): string =>
  JSON.stringify(v).replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

export const writeWindows = async (run: RunProcess, html: string, text: string): Promise<boolean> => {
  const utf16le: number[] = []
  for (let i = 0; i < WIN_SCRIPT.length; i++) {
    const c = WIN_SCRIPT.charCodeAt(i)
    utf16le.push(c & 255, c >> 8)
  }
  const r = await run(
    ['powershell.exe', '-STA', '-NoProfile', '-NonInteractive', '-EncodedCommand', base64(utf16le)],
    { stdin: asciiJson({ html, text }), timeoutMs: 15000 },
  )
  return r.exitCode === 0
}

export const writeMac = async (run: RunProcess, html: string, text: string): Promise<boolean> => {
  const script = `set the clipboard to {«class HTML»:«data HTML${toHex(html)}», «class utf8»:«data utf8${toHex(text)}»}`
  const r = await run(['osascript', '-e', script], { timeoutMs: 15000 })
  return r.exitCode === 0
}

export const writeLinux = async (run: RunProcess, html: string): Promise<boolean> => {
  for (const argv of [
    ['wl-copy', '--type', 'text/html'],
    ['xclip', '-selection', 'clipboard', '-t', 'text/html'],
  ]) {
    try {
      const r = await run(argv, { stdin: html, timeoutMs: 5000 })
      if (r.exitCode === 0) return true
    } catch {
      // tool missing or did not exit: try the next one
    }
  }
  return false
}

type Method = 'win' | 'mac' | 'linux'
let lastWorking: Method | '' = ''

// True when the OS clipboard now holds the rich link; false means the caller should fall back.
export const writeRich = async (run: RunProcess, html: string, text: string): Promise<boolean> => {
  const tries: Record<Method, () => Promise<boolean>> = {
    win: () => writeWindows(run, html, text),
    mac: () => writeMac(run, html, text),
    linux: () => writeLinux(run, html),
  }
  const all: Method[] = ['win', 'mac', 'linux']
  const order = lastWorking ? [lastWorking, ...all.filter(k => k !== lastWorking)] : all
  for (const k of order) {
    try {
      if (await tries[k]()) {
        lastWorking = k
        return true
      }
    } catch {
      // executable not found on this platform
    }
  }
  return false
}
