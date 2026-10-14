// Prueba del motor de cálculo sobre el caso sintético del README,
// tanto en index.html (fuente) como en dist/index.html (versión publicada).
// Uso: npm run build && npm test
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

function load(file) {
  const html = readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 3, `${file}: se esperaban 3 scripts en línea`);
  // Todos los scripts deben compilar.
  scripts.forEach((s, i) => new vm.Script(s, { filename: `${file}#script${i}` }));
  const ctx = vm.createContext({ globalThis: undefined });
  ctx.globalThis = ctx;
  vm.runInContext(scripts[0], ctx); // motor
  vm.runInContext(scripts[1] + ';globalThis.__ROWS=DEMO_ROWS;', ctx); // tabla de aforo demo
  return { E: ctx.OilEngine, rows: ctx.__ROWS };
}

function run(file) {
  const { E, rows } = load(file);
  const tank = { table: rows, alpha: 6.2e-6, tBase: 60 };
  const side = (lv, tv) => E.measure(tank, { levelMm: lv, fwlMm: 0, tempF: E.tempFromReadings(tv), api60: 21.3, bsw: 0.35, ambF: '', fra: 0 });
  const o = side(10420, [152.8, 153.4, 154.0]);
  const c = side(9790, [152.3, 152.9, 153.5]);
  const D = E.dispatch(o, c);
  assert.equal(D.gov, 2532.43);
  assert.equal(D.gsv, 2428.89);
  assert.equal(D.csw, 0.9965);
  assert.equal(D.nsv, 2420.39);
  // Referencia de la Tabla 6A (API MPMS 11.1): 30,0 °API a 100 °F → 0,9821
  assert.equal(E.CTL(30, 100), 0.9821);
  const vols = [227.8, 235.57, 220.02, 233.35, 230.02, 238.91, 222.24, 231.13, 234.46, 226.69, 232.24];
  const p = E.prorate(D, vols.map((v, i) => ({ id: 'V' + i, vol: v })));
  assert.ok(p.ok, 'el prorrateo debe cuadrar con los totales del despacho');
  console.log(`OK ${file}: GOV ${D.gov} · GSV ${D.gsv} · NSV ${D.nsv}`);
}

run('index.html');
if (existsSync('dist/index.html')) run('dist/index.html');
