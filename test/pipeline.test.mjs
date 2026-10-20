// Prueba del módulo de compensación volumétrica en oleoductos (PipelineEngine),
// sobre index.html (fuente) y dist/index.html (versión publicada).
// Valores verificados con un cálculo independiente en aritmética decimal.
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

function load(file) {
  const html = readFileSync(file, 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('PipelineEngine') && s.includes('shrinkPct'));
  assert.ok(code, `${file}: no se encontró el motor de oleoducto`);
  const ctx = vm.createContext({}); ctx.window = ctx;
  vm.runInContext(code, ctx);
  return ctx.PipelineEngine;
}

function run(file) {
  const P = load(file);
  const r = P.compute(P.demo());
  assert.ok(r.ok, 'todos los cuadres deben cumplirse');
  const [b1, b2] = r.blends;
  assert.equal(b1.PNI, 772);
  assert.equal(b1.PNIpct, 0.1499);
  assert.equal(b1.quality.api, 20.5);
  assert.equal(b1.Pb, 66.780303);
  const andina = b1.lines.find((l) => l.shipperName === 'Andina Oil');
  assert.equal(andina.vn, 119792.16);
  assert.equal(andina.fc, 1.078537);
  assert.equal(andina.dv, 9408.07);
  assert.equal(b1.lines.reduce((s, l) => s + P.toC(l.dv), 0), 0, 'la CVC debe sumar cero');
  assert.equal(b2.PNI, 950); assert.equal(b2.alloc, 900); assert.equal(b2.absorbed, 50);
  // Reparto 60/40 exacto de un lote entre corrientes
  const c2 = r.blends.flatMap((b) => b.lines).filter((l) => l.crude === 'C2');
  assert.equal(c2.reduce((s, l) => s + P.toC(l.v), 0), 15000000);
  // Validación: el reparto debe sumar 100 %
  const d = P.demo(); d.entries[3].route = { B1: 60, B2: 30 };
  assert.throws(() => P.compute(d), /suma 90/);
  // API MPMS 12.3: C = 30 %, ΔAPI = 20 → 0,0438 %
  assert.equal(P.round(P.shrinkPct(30, 20), 4), 0.0438);
  console.log(`OK ${file}: oleoducto · PNI ${b1.PNI} · pool ${b1.Pb} · FCV Andina ${andina.fcv}`);
}

run('index.html');
if (existsSync('dist/index.html')) run('dist/index.html');
