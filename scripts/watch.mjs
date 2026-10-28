// Modo desarrollo: reconstruye _site/ cada vez que cambia algo en content/ o
// web/, y lo sirve con "serve". Uso: npm run dev
import { watch } from "chokidar";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUILD_SCRIPT = path.join(ROOT, "scripts", "build.mjs");

let building = false;
let pending = false;

function runBuild() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  const proc = spawn(process.execPath, [BUILD_SCRIPT], {
    cwd: ROOT,
    stdio: "inherit",
  });
  proc.on("exit", () => {
    building = false;
    if (pending) {
      pending = false;
      runBuild();
    }
  });
}

// Agrupa ráfagas de cambios (p.ej. guardar varios ficheros a la vez) en una
// sola reconstrucción.
let debounceTimer = null;
function scheduleBuild() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runBuild, 150);
}

runBuild();

watch([path.join(ROOT, "content"), path.join(ROOT, "web")], {
  ignoreInitial: true,
  // El propio build.mjs escribe (y borra) ficheros temporales
  // ".__mermaid_tmp_*" dentro de content/slides/: hay que ignorarlos o el
  // watcher se dispararía a sí mismo en un bucle infinito.
  ignored: (filePath) => path.basename(filePath).startsWith(".__mermaid_tmp_"),
}).on("all", (event, filePath) => {
  console.log(`[watch] ${event}: ${path.relative(ROOT, filePath)}`);
  scheduleBuild();
});

spawn("npx", ["serve", "_site"], { cwd: ROOT, stdio: "inherit" });
