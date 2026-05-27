import { NextRequest, NextResponse } from 'next/server'
import puppeteer, { type PDFOptions, type PaperFormat } from 'puppeteer-core'
import chromium from '@sparticuz/chromium'

// Puppeteer needs the Node runtime (it spawns a real Chromium process) — never edge.
export const runtime = 'nodejs'
// PDF generation (browser launch + render + capture) can take a few seconds.
export const maxDuration = 30

type MarginInput = { top?: string; right?: string; bottom?: string; left?: string }
type Body = {
  html?: string
  format?: string
  orientation?: string
  margin?: MarginInput
  scale?: number
  printBackground?: boolean
  filename?: string
}

const VALID_FORMATS: Record<string, PaperFormat> = {
  letter: 'letter', legal: 'legal', a4: 'a4', tabloid: 'tabloid',
}

/** Launch Chromium — bundled @sparticuz binary on Vercel, local Chrome in dev. */
async function launchBrowser() {
  const isServerless = !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.VERCEL
  if (isServerless) {
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: true,
    })
  }
  // Local dev: use an installed Chrome/Chromium (the @sparticuz binary is Linux-only).
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[]
  const executablePath = candidates[0]
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
}

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { html, format, orientation, margin, scale, printBackground, filename } = body

  if (!html || typeof html !== 'string' || !html.trim()) {
    return NextResponse.json({ error: 'No HTML provided. Paste or upload some HTML first.' }, { status: 400 })
  }

  // Normalize options
  const paperFormat = VALID_FORMATS[(format ?? 'letter').toLowerCase()] ?? 'letter'
  const landscape = (orientation ?? 'portrait').toLowerCase() === 'landscape'
  // Puppeteer scale must be in [0.1, 2]. The UI sends a fraction (1 = 100%).
  const safeScale = Math.min(2, Math.max(0.1, Number.isFinite(scale) ? Number(scale) : 1))
  const safeFilename = (filename ?? 'document.pdf').trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'document.pdf'
  const finalName = safeFilename.toLowerCase().endsWith('.pdf') ? safeFilename : `${safeFilename}.pdf`

  const pdfOptions: PDFOptions = {
    format: paperFormat,
    landscape,
    scale: safeScale,
    printBackground: printBackground !== false, // default ON — flyers break without it
    margin: {
      top: margin?.top ?? '0',
      right: margin?.right ?? '0',
      bottom: margin?.bottom ?? '0',
      left: margin?.left ?? '0',
    },
    preferCSSPageSize: false,
  }

  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null
  try {
    browser = await launchBrowser()
    const page = await browser.newPage()
    // networkidle0 → wait for web fonts / external images to settle before capture.
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20_000 })
    const pdf = await page.pdf(pdfOptions)

    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${finalName}"`,
        'Content-Length': String(pdf.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[generate-pdf] failed:', message)
    return NextResponse.json(
      { error: `PDF generation failed: ${message}` },
      { status: 500 },
    )
  } finally {
    if (browser) { try { await browser.close() } catch { /* ignore */ } }
  }
}
