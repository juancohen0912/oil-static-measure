// Construye dist/index.html: minifica y ofusca los scripts y estilos en línea,
// elimina comentarios y deja solo el aviso de copyright.
// © 2026 Juan Cohen. Todos los derechos reservados.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { transform } from 'esbuild';

const BANNER = '/*! Oil Static Measure · © 2026 Juan Cohen. Todos los derechos reservados. Prohibida su copia o distribución sin autorización escrita. */';
const HTML_NOTICE = '<!-- Oil Static Measure · © 2026 Juan Cohen. Todos los derechos reservados. -->';

let html = readFileSync('index.html', 'utf8');

// Quita comentarios HTML (incluido el bloque de copyright largo, que se reemplaza por uno corto).
html = html.replace(/<!--[\s\S]*?-->\s*/g, '');

async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(re)) {
    parts.push(str.slice(last, m.index), await fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join('');
}

// Scripts en línea (sin src): minificación con renombrado de variables locales.
// Sin "format", esbuild conserva los nombres globales de nivel superior (p. ej. DEMO_ROWS),
// que otros scripts de la página usan.
html = await replaceAsync(html, /<script>([\s\S]*?)<\/script>/g, async (_all, code) => {
  const out = await transform(code, { loader: 'js', minify: true, target: 'es2020', legalComments: 'none' });
  return `<script>${BANNER}${out.code.trim()}</script>`;
});

// Estilos en línea.
html = await replaceAsync(html, /<style>([\s\S]*?)<\/style>/g, async (_all, css) => {
  const out = await transform(css, { loader: 'css', minify: true, legalComments: 'none' });
  return `<style>${out.code.trim()}</style>`;
});

html = html.replace(/^<!doctype html>/i, `<!doctype html>\n${HTML_NOTICE}`);

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
writeFileSync('dist/index.html', html);
console.log(`dist/index.html listo (${(html.length / 1024).toFixed(0)} KB)`);
