// Genera el sitio estático en _site/ a partir de content/ y web/.
// Uso: node scripts/build.mjs
import { marpCli } from '@marp-team/marp-cli'
import frontMatter from 'front-matter'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SITE = path.join(ROOT, '_site')
const SLIDES_SRC = path.join(ROOT, 'content', 'slides')
const PRACTICAS_SRC = path.join(ROOT, 'content', 'practicas')
const THEME = path.join(SLIDES_SRC, 'theme', 'umu.css')
const WEB_SRC = path.join(ROOT, 'web')

// Favicon compartido (emoji de infinito ♾️) para las diapositivas y las prácticas.
// web/index.html define el suyo aparte, directamente en el HTML.
const FAVICON_LINK =
  "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>♾️</text></svg>\">"

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value
      } catch {
        // fall through to default escaping
      }
    }
    return md.utils.escapeHtml(str)
  },
})

// Los bloques ```mermaid no se resaltan como código: se renderizan como
// diagrama en el navegador (mermaid.js los busca por su clase "mermaid").
const defaultFenceRenderer =
  md.renderer.rules.fence ||
  function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options)
  }
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const lang = token.info.trim()
  if (lang === 'mermaid') {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`
  }
  return defaultFenceRenderer(tokens, idx, options, env, self)
}

// Slug al estilo GitHub, para que los enlaces manuales de un Índice
// (p.ej. "[Tema](#1-mi-titulo)") apunten de verdad a su cabecera.
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

function headingText(tokens, idx) {
  const inline = tokens[idx + 1]
  if (!inline || !inline.children) return ''
  return inline.children
    .filter((t) => t.type === 'text' || t.type === 'code_inline')
    .map((t) => t.content)
    .join('')
}

// Asigna un id a cada cabecera (h1-h6) a partir de su texto, gestionando
// duplicados igual que GitHub (segunda aparición de "x" -> "x-1", etc.).
md.core.ruler.push('heading_ids', (state) => {
  const slugCounts = new Map()
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i]
    if (token.type !== 'heading_open') continue
    let slug = slugify(headingText(state.tokens, i))
    const count = slugCounts.get(slug) || 0
    slugCounts.set(slug, count + 1)
    if (count > 0) slug = `${slug}-${count}`
    token.attrSet('id', slug)
  }
})

async function rmrf(target) {
  await fs.rm(target, { recursive: true, force: true })
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(s, d)
    } else {
      await fs.copyFile(s, d)
    }
  }
}

// Extrae el número inicial del nombre de fichero para ordenar (tema3-x.md -> 3).
// Ficheros sin número (p.ej. proyecto.md) van al final, por orden alfabético.
function orderOf(filename) {
  const match = filename.match(/(\d+)/)
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER
}

function titleFromMarkdown(body, fallback) {
  const heading = body.match(/^#\s+(.+)$/m)
  return heading ? heading[1].trim() : fallback
}

// Marp deja los bloques ```mermaid como <pre><code class="language-mermaid">.
// Los renderizamos en el navegador con mermaid.render(), que dibuja en un
// contenedor temporal fuera de la diapositiva: así las medidas del texto no se
// ven alteradas por el escalado (transform) con el que Marp ajusta cada slide.
const SLIDES_MERMAID_SCRIPT = `<script src="../vendor/mermaid.min.js"></script>
<script>
mermaid.initialize({ startOnLoad: false })
document.querySelectorAll('code.language-mermaid').forEach(function (code, i) {
  mermaid.render('mermaid-slide-' + i, code.textContent).then(function (result) {
    var figure = document.createElement('div')
    figure.className = 'mermaid-diagram'
    figure.innerHTML = result.svg
    code.parentElement.replaceWith(figure)
  })
})
</script>
`

async function buildSlides() {
  const files = (await fs.readdir(SLIDES_SRC)).filter((f) => f.endsWith('.md'))
  const outDir = path.join(SITE, 'slides')
  await fs.mkdir(outDir, { recursive: true })

  // Las diapositivas referencian imágenes con rutas relativas (assets/temaN/...).
  // Marp CLI no las embebe en el HTML, así que copiamos la carpeta de assets
  // conservando la misma estructura relativa que en content/slides/.
  const assetsSrc = path.join(SLIDES_SRC, 'assets')
  if (existsSync(assetsSrc)) {
    await copyDir(assetsSrc, path.join(outDir, 'assets'))
  }

  const manifest = []
  for (const file of files) {
    const slug = file.replace(/\.md$/, '')
    const srcPath = path.join(SLIDES_SRC, file)
    const outPath = path.join(outDir, `${slug}.html`)
    const raw = await fs.readFile(srcPath, 'utf-8')
    const { attributes, body } = frontMatter(raw)
    const title = attributes.title || titleFromMarkdown(body, slug)

    // Marp no sabe renderizar bloques ```mermaid (eso lo hace mermaid.js en
    // el navegador). Los convertimos a <pre class="mermaid"> en crudo: como
    // <pre> es una etiqueta de bloque HTML reconocida por CommonMark, Marp
    // (con --html) la deja pasar tal cual, igual que hace ya con los <div>
    // de layout de estas diapositivas.
    const mermaidProcessedRaw = raw.replace(
      /```mermaid\n([\s\S]*?)```/g,
      (_, code) => `<pre class="mermaid">\n${md.utils.escapeHtml(code)}</pre>\n`,
    )
    const hasMermaid = mermaidProcessedRaw !== raw

    // Si hay diagramas, Marp tiene que leer la versión ya convertida. Se
    // escribe como fichero temporal junto al original para que las
    // referencias relativas a assets/ sigan resolviendo igual.
    const marpSrcPath = hasMermaid ? path.join(SLIDES_SRC, `.__mermaid_tmp_${file}`) : srcPath
    if (hasMermaid) {
      await fs.writeFile(marpSrcPath, mermaidProcessedRaw, 'utf-8')
    }

    let exitCode
    try {
      exitCode = await marpCli([
        marpSrcPath,
        '--html',
        '--allow-local-files',
        '--theme-set',
        THEME,
        '-o',
        outPath,
      ])
    } finally {
      if (hasMermaid) await fs.rm(marpSrcPath, { force: true })
    }
    if (exitCode !== 0) {
      throw new Error(`Marp CLI falló al generar ${file} (código ${exitCode})`)
    }

    // Marp CLI no tiene una opción para fijar el favicon: lo inyectamos
    // después, a mano, en el <head> del HTML ya generado. Si hay diagramas
    // Mermaid, también inyectamos aquí el script que los renderiza (Marp no
    // sabe hacerlo).
    let generatedHtml = await fs.readFile(outPath, 'utf-8')
    generatedHtml = generatedHtml.replace('<head>', `<head>${FAVICON_LINK}`)
    if (hasMermaid) {
      generatedHtml = generatedHtml.replace('</body>', `${MERMAID_PAN_ZOOM_SCRIPT}</body>`)
    }
    await fs.writeFile(outPath, generatedHtml, 'utf-8')

    // Copia el .md original para el botón "Descargar MD" del visor.
    await fs.copyFile(srcPath, path.join(outDir, file))

    manifest.push({
      id: slug,
      title,
      type: 'slides',
      file: `slides/${slug}.html`,
      source: `slides/${file}`,
      order: orderOf(slug),
    })
  }

  manifest.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return manifest
}

// Tras renderizar cada diagrama Mermaid, lo envuelve con zoom (rueda del
// ratón, centrado en el cursor) y paneo (arrastrar), más una mini barra de
// botones +/-/reset para quien no tenga ratón con rueda.
const MERMAID_PAN_ZOOM_SCRIPT = `<script src="../vendor/mermaid.min.js"></script>
<script>
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
})
mermaid.run({ querySelector: '.mermaid' }).then(function () {
  document.querySelectorAll('pre.mermaid').forEach(setupPanZoom)
})

function setupPanZoom(container) {
  var svg = container.querySelector('svg')
  if (!svg) return

  var state = { scale: 1, x: 0, y: 0 }
  var MIN_SCALE = 0.4
  var MAX_SCALE = 6

  container.classList.add('mz-wrap')
  svg.classList.add('mz-svg')

  function apply() {
    svg.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) scale(' + state.scale + ')'
  }

  function zoomBy(factor, cx, cy) {
    var newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor))
    var ratio = newScale / state.scale
    state.x = cx - (cx - state.x) * ratio
    state.y = cy - (cy - state.y) * ratio
    state.scale = newScale
    apply()
  }

  container.addEventListener('wheel', function (e) {
    e.preventDefault()
    var rect = container.getBoundingClientRect()
    var cx = e.clientX - rect.left - rect.width / 2
    var cy = e.clientY - rect.top - rect.height / 2
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, cx, cy)
  }, { passive: false })

  var dragging = false
  var startX, startY, origX, origY

  container.addEventListener('pointerdown', function (e) {
    // No empieces un arrastre si el clic viene de la barra de zoom: si no,
    // capturar el puntero aquí interfiere con el click del propio botón.
    if (e.target.closest('.mz-toolbar')) return
    dragging = true
    startX = e.clientX
    startY = e.clientY
    origX = state.x
    origY = state.y
    container.setPointerCapture(e.pointerId)
    container.classList.add('mz-dragging')
  })
  container.addEventListener('pointermove', function (e) {
    if (!dragging) return
    state.x = origX + (e.clientX - startX)
    state.y = origY + (e.clientY - startY)
    apply()
  })
  function endDrag(e) {
    dragging = false
    container.classList.remove('mz-dragging')
    // Sin esto, los clics posteriores en la barra de zoom se redirigen al
    // contenedor (que sigue "capturando" el puntero) en vez de al botón.
    if (container.hasPointerCapture(e.pointerId)) {
      container.releasePointerCapture(e.pointerId)
    }
  }
  container.addEventListener('pointerup', endDrag)
  container.addEventListener('pointercancel', endDrag)
  container.addEventListener('dblclick', function () {
    state = { scale: 1, x: 0, y: 0 }
    apply()
  })

  var toolbar = document.createElement('div')
  toolbar.className = 'mz-toolbar'
  toolbar.innerHTML =
    '<button type="button" data-act="in" title="Acercar">+</button>' +
    '<button type="button" data-act="out" title="Alejar">\\u2212</button>' +
    '<button type="button" data-act="reset" title="Restablecer">\\u27f2</button>'
  toolbar.addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act')
    if (act === 'in') zoomBy(1.2, 0, 0)
    else if (act === 'out') zoomBy(1 / 1.2, 0, 0)
    else if (act === 'reset') {
      state = { scale: 1, x: 0, y: 0 }
      apply()
    }
  })
  container.appendChild(toolbar)
}
</script>`

// Añade un botón "copiar" a cada bloque de código (excepto los diagramas Mermaid).
const COPY_BUTTON_SCRIPT = `<script>
(function () {
  var ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>'
  var ICON_OK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>'

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text)
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      var ok = false
      try { ok = document.execCommand('copy') } catch (e) {}
      document.body.removeChild(ta)
      ok ? resolve() : reject()
    })
  }

  document.querySelectorAll('.markdown-body pre:not(.mermaid)').forEach(function (pre) {
    var wrap = document.createElement('div')
    wrap.className = 'code-block'
    pre.parentNode.insertBefore(wrap, pre)
    wrap.appendChild(pre)

    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'copy-btn'
    btn.title = 'Copiar código'
    btn.setAttribute('aria-label', 'Copiar código')
    btn.innerHTML = ICON_COPY
    btn.addEventListener('click', function () {
      copyText(pre.innerText.replace(/\\n$/, '')).then(function () {
        btn.classList.add('copied')
        btn.innerHTML = ICON_OK + 'Copiado'
        setTimeout(function () {
          btn.classList.remove('copied')
          btn.innerHTML = ICON_COPY
        }, 1500)
      })
    })
    wrap.appendChild(btn)
  })
})()
</script>`

function practicaTemplate({ title, contentHtml }) {
  const hasMermaid = contentHtml.includes('class="mermaid"')
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${FAVICON_LINK}
<script>
  // El tema (claro/oscuro) lo elige el usuario en el shell y se guarda en localStorage.
  var theme = 'light'
  try { if (localStorage.getItem('theme') === 'dark') theme = 'dark' } catch (e) {}
  document.documentElement.dataset.theme = theme
  document.write(
    '<link rel="stylesheet" href="../vendor/github-markdown-' + theme + '.css">' +
    '<link rel="stylesheet" href="../vendor/highlight-' + theme + '.css">'
  )
</script>
<style>
  body {
    margin: 0;
    padding: 2.5rem 1.5rem 4rem;
    background: #ffffff;
  }
  :root[data-theme="dark"] body { background: #0d1117; }
  :root[data-theme="dark"] .mz-toolbar button {
    background: #161b22;
    border-color: #30363d;
    color: #e6edf3;
  }
  :root[data-theme="dark"] .mz-toolbar button:hover { background: #21262d; }
  :root[data-theme="dark"] .copy-btn {
    background: #161b22;
    border-color: #30363d;
    color: #9da7b3;
  }
  :root[data-theme="dark"] .copy-btn:hover { background: #21262d; }
  :root[data-theme="dark"] .copy-btn.copied { color: #3fb950; }
  .markdown-body {
    box-sizing: border-box;
    max-width: 860px;
    margin: 0 auto;
  }
  .markdown-body pre code.hljs { padding: 0; }
  .markdown-body pre.mermaid {
    background: none;
    border: none;
    text-align: center;
  }
  .markdown-body pre.mermaid.mz-wrap {
    position: relative;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
  }
  .markdown-body pre.mermaid.mz-wrap.mz-dragging {
    cursor: grabbing;
  }
  .markdown-body pre.mermaid .mz-svg {
    transform-origin: center center;
    display: block;
    margin: 0 auto;
  }
  .mz-toolbar {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    display: flex;
    gap: 0.25rem;
  }
  .mz-toolbar button {
    width: 1.6rem;
    height: 1.6rem;
    border: 1px solid #d7dde3;
    background: #ffffff;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    line-height: 1;
    padding: 0;
  }
  .mz-toolbar button:hover {
    background: #f0f2f4;
  }
  .code-block {
    position: relative;
  }
  .code-block > pre {
    margin-bottom: 0;
  }
  .code-block {
    margin-bottom: 1rem;
  }
  .copy-btn {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.45rem;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #ffffff;
    color: #57606a;
    font: 12px/1 system-ui, sans-serif;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .code-block:hover .copy-btn,
  .copy-btn:focus-visible,
  .copy-btn.copied {
    opacity: 1;
  }
  .copy-btn:hover {
    background: #f3f4f6;
  }
  .copy-btn.copied {
    color: #1a7f37;
  }
  .copy-btn svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
  }
  @media (hover: none) {
    .copy-btn { opacity: 1; }
  }
</style>
</head>
<body>
  <article class="markdown-body">
    ${contentHtml}
  </article>
  ${hasMermaid ? MERMAID_PAN_ZOOM_SCRIPT : ''}
  ${COPY_BUTTON_SCRIPT}
</body>
</html>
`
}

async function buildPracticas() {
  const files = (await fs.readdir(PRACTICAS_SRC)).filter((f) => f.endsWith('.md'))
  const outDir = path.join(SITE, 'practicas')
  await fs.mkdir(outDir, { recursive: true })

  // Los boletines usan rutas relativas a assets/; conserva su estructura al publicarlos.
  const assetsSrc = path.join(PRACTICAS_SRC, 'assets')
  if (existsSync(assetsSrc)) {
    await copyDir(assetsSrc, path.join(outDir, 'assets'))
  }

  const manifest = []
  for (const file of files) {
    const slug = file.replace(/\.md$/, '')
    const srcPath = path.join(PRACTICAS_SRC, file)
    const outPath = path.join(outDir, `${slug}.html`)
    const raw = await fs.readFile(srcPath, 'utf-8')
    const { attributes, body } = frontMatter(raw)
    const title = attributes.title || titleFromMarkdown(body, slug)
    const contentHtml = md.render(body)

    await fs.writeFile(outPath, practicaTemplate({ title, contentHtml }), 'utf-8')

    // Copia el .md original para el botón "Descargar MD" del visor.
    await fs.copyFile(srcPath, path.join(outDir, file))

    manifest.push({
      id: slug,
      title,
      type: 'practica',
      file: `practicas/${slug}.html`,
      source: `practicas/${file}`,
      order: orderOf(slug),
    })
  }

  manifest.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return manifest
}

async function copyVendorAssets() {
  const vendorDir = path.join(SITE, 'vendor')
  await fs.mkdir(vendorDir, { recursive: true })
  for (const theme of ['light', 'dark']) {
    await fs.copyFile(
      path.join(ROOT, 'node_modules', 'github-markdown-css', `github-markdown-${theme}.css`),
      path.join(vendorDir, `github-markdown-${theme}.css`),
    )
  }
  await fs.copyFile(
    path.join(ROOT, 'node_modules', 'highlight.js', 'styles', 'github.css'),
    path.join(vendorDir, 'highlight-light.css'),
  )
  await fs.copyFile(
    path.join(ROOT, 'node_modules', 'highlight.js', 'styles', 'github-dark.css'),
    path.join(vendorDir, 'highlight-dark.css'),
  )
  await fs.copyFile(
    path.join(ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    path.join(vendorDir, 'mermaid.min.js'),
  )
}

async function main() {
  console.log('Limpiando _site/ ...')
  await rmrf(SITE)
  await fs.mkdir(SITE, { recursive: true })

  console.log('Copiando shell web (web/) ...')
  if (!existsSync(WEB_SRC)) throw new Error('No existe la carpeta web/')
  await copyDir(WEB_SRC, SITE)

  console.log('Copiando dependencias de estilo (github-markdown-css, highlight.js) ...')
  await copyVendorAssets()

  console.log('Generando diapositivas con Marp CLI ...')
  const temas = await buildSlides()

  console.log('Generando boletines de prácticas ...')
  const practicas = await buildPracticas()

  console.log('Escribiendo manifest.json ...')
  await fs.writeFile(
    path.join(SITE, 'manifest.json'),
    JSON.stringify({ temas, practicas }, null, 2),
    'utf-8',
  )

  console.log(`Listo: ${temas.length} temas, ${practicas.length} prácticas en _site/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
