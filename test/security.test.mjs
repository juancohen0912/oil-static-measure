// Verifica la versión publicada: CSP con la huella de cada script en línea,
// sin manejadores en línea, sin claves secretas y con la app oculta hasta autenticar.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const html = readFileSync('dist/index.html', 'utf8');
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
assert.ok(meta, 'falta la CSP');
const csp = meta[1];
for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  const h = `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;
  assert.ok(csp.includes(h), 'script en línea sin huella en la CSP');
}
assert.ok(!/'unsafe-eval'/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp), 'la CSP no debe permitir eval ni scripts en línea arbitrarios');
assert.match(csp, /connect-src https:\/\/aqpbthffuoegawxswwhf\.supabase\.co(;|$)/);
assert.ok(!/\son[a-z]+="/i.test(html.replace(/<script>[\s\S]*?<\/script>/g, '')), 'no debe haber manejadores en línea');
assert.ok(!/service_role|sb_secret_/.test(html), 'nunca debe publicarse una clave de servicio');
assert.ok(/<div class="wrap" hidden>/.test(html), 'la app debe estar oculta hasta autenticar');
console.log('OK dist/index.html: CSP con', (csp.match(/sha256-/g) || []).length, 'huellas; sin claves secretas');
