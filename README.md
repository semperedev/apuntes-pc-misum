# Prácticas Continuas — Apuntes

Sitio web de la asignatura, publicado con **GitHub Pages** y desplegado automáticamente en cada `push` a `main`. Incluye:

- Las **diapositivas de teoría** (6 temas), escritas en Markdown con [Marp](https://marp.app/) y navegables con las flechas del teclado, con un botón para proyectarlas a pantalla completa.
- Los **boletines de prácticas** (boletín 0 de guía + 7 sesiones + proyecto), en Markdown normal (documento, no diapositivas).
- Un selector web sencillo para elegir qué tema o práctica ver.

---

## Estructura del repositorio

```
content/
  slides/                  # Teoría (Marp)
    temaN-slug.md
    theme/umu.css          # Tema visual de las diapositivas
    assets/temaN/...       # Imágenes usadas por cada tema
  practicas/               # Boletines (Markdown normal)
    boletinN-slug.md
    proyecto.md
web/                        # Shell de la web (se copia tal cual al build)
  index.html
  styles.css
  app.js
scripts/
  build.mjs                # Genera _site/ a partir de content/ y web/
material/                   # Material antiguo en LaTeX/Beamer (archivo histórico, no se usa en la web)
.github/workflows/deploy.yml
.marprc.yml                # Configuración de Marp CLI (desactiva el CDN de emojis)
package.json
```

El build genera una carpeta `_site/` (no versionada) que es exactamente lo que se publica en GitHub Pages: las diapositivas convertidas a HTML, los boletines convertidos a HTML, el shell web y un `manifest.json` con el listado de todo el contenido.

---

## Previsualizar en local

Requiere [Node.js](https://nodejs.org/) 20+.

```bash
npm install
npm run dev
```

`npm run dev` compila el sitio (`npm run build`) y lo sirve en `http://localhost:3000` (o el puerto que indique `serve`). Volver a ejecutar `npm run build` tras cada cambio (o dejar `npm run dev` corriendo y refrescar el navegador).

Si solo queréis compilar sin servir: `npm run build` (la salida queda en `_site/`).

---

## Cómo añadir un tema de teoría nuevo

1. Crear un fichero en `content/slides/temaN-slug.md` (el número al principio del nombre determina el orden en el menú; el "slug" es libre, en minúsculas y sin espacios).
2. Empezar el fichero con el frontmatter de Marp:

   ```markdown
   ---
   marp: true
   theme: umu
   paginate: true
   title: "Tema N: Título del tema"
   footer: "Prácticas Continuas · Tema N"
   ---
   ```

3. Escribir las diapositivas separadas por `---` (una línea con solo tres guiones). El **título de la página** (el que aparece en el menú de la web) es el que se indique en `title:`; si no se indica, se usa el primer `# Encabezado` del documento.
4. Si el tema usa imágenes, guardarlas en `content/slides/assets/temaN/` y referenciarlas como `![](assets/temaN/nombre.png)`.
5. Hacer commit y push a `main`. El tema aparecerá automáticamente en la web tras el despliegue — **no hace falta tocar ni el HTML ni el manifest**, se generan solos escaneando la carpeta.

### Sintaxis básica de Marp

- `---` en una línea sola separa diapositivas.
- `<!-- _class: lead -->` antes de una diapositiva le aplica el estilo de portada (fondo de color, texto centrado); usado en la portada de cada tema.
- `<!-- _class: divider -->` aplica el estilo de separador de sección.
- `<!-- _paginate: false -->` / `<!-- _footer: "" -->` ocultan el número de página o el pie en una diapositiva concreta (se usa en portadas y cierres).
- `![w:500](ruta.png)` inserta una imagen con un ancho de 500px (ajustar según convenga).
- Tablas y bloques de código Markdown normales funcionan igual que en cualquier `.md`.
- Documentación completa: <https://marpit.marp.app/markdown>.

Para cambiar el aspecto visual (colores, tipografía) de **todas** las diapositivas a la vez, editar `content/slides/theme/umu.css`.

---

## Cómo añadir o editar un boletín de prácticas

1. Crear (o editar) un fichero en `content/practicas/boletinN-slug.md` (o `proyecto.md`, que no lleva número y siempre aparece al final del listado).
2. Frontmatter mínimo:

   ```markdown
   ---
   title: "Práctica N: Título"
   ---
   ```

3. Escribir el contenido en Markdown normal (no es una presentación: se renderiza como un documento con estilo GitHub). Se recomienda mantener la misma estructura que los boletines existentes: **Objetivos**, **Relación con el temario**, **Contexto**, **Tareas**, **Entregables**, **Criterios de evaluación**.
4. Para enlazar a un tema de teoría desde un boletín: `[Tema N](../slides/temaN-slug.html)`.
5. Para añadir imágenes, guardarlas en `content/practicas/assets/` y enlazarlas con una ruta relativa: `![Descripción](assets/boletinN/imagen.png)`. Para controlar su tamaño, usar HTML: `<img src="assets/boletinN/imagen.png" alt="Descripción" width="480">`.
6. Hacer commit y push a `main`. Aparecerá automáticamente en la sección "Prácticas" del menú.

---

## Cómo funciona el despliegue automático

El workflow `.github/workflows/deploy.yml` se ejecuta en cada `push` a `main`:

1. Instala dependencias (`npm ci`).
2. Genera el sitio (`npm run build` → `_site/`).
3. Publica `_site/` en GitHub Pages.

**Paso único que hay que hacer a mano la primera vez** (no se puede automatizar desde el propio repositorio): en GitHub, ir a `Settings → Pages` y en "Build and deployment → Source" seleccionar **"GitHub Actions"**. A partir de ahí, cada push a `main` recompila y republica el sitio solo.

---

## Notas sobre el visor web

- Al entrar en la web (o al pulsar el título "Prácticas Continuas" en la barra lateral) se muestra una **página de inicio** con una rejilla de tarjetas con todos los temas y prácticas disponibles; al hacer clic en una tarjeta o en un elemento del menú se abre su contenido.
- El menú (barra lateral) y la página de inicio se generan dinámicamente a partir de `manifest.json`, que crea el script de build escaneando `content/slides/` y `content/practicas/` — por eso añadir contenido nuevo no requiere tocar código de la web.
- Las diapositivas se cargan en un `<iframe>`; el HTML que genera Marp ya incluye su propia navegación por teclado (flechas, espacio, tecla `f` para pantalla completa) — no hay que reimplementar nada.
- El botón **"Presentar"** pone el `<iframe>` en pantalla completa (API `requestFullscreen`), útil para proyectar en clase.
- Los boletines de prácticas se cargan igual en el iframe, pero como documento normal (con scroll, sin paginación).

---

## Sobre `material/`

La carpeta `material/` contiene el temario antiguo en LaTeX/Beamer, previo a la reorganización de la asignatura. Se conserva como referencia histórica y ha sido usado como base para el desarrollo del contenido actual.
