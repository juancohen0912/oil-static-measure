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

function checkTickets(E, D, p, tag) {
  assert.ok(p.ok, tag + ': Σ GOV, GSV y NSV deben cuadrar con el despacho');
  for (const k of ['gov', 'gsv', 'nsv'])
    assert.equal(Math.round(p.rows.reduce((s, r) => s + r[k + 'A'], 0) * 100), Math.round(D[k] * 100), tag + ': Σ ' + k);
  for (const r of p.rows) {
    assert.equal(r.bswA, D.bswUsed, tag + ': %BSW igual en todas las placas');
    assert.equal(r.apiA, D.api60, tag + ': API igual en todas las placas');
    assert.equal(r.ctlA, E.CTL(D.api60, r.tA), tag + ': CTL = Tabla 6A(API, T equivalente)');
    assert.ok(Math.abs(r.tA - p.t0) <= p.tMaxDev + 1e-9, tag + ': desviación de T dentro del límite');
    if (!r.adj) assert.ok(r.ticketOk, tag + ': ' + r.id + ' tiquete reproducible');
    else if (!/Lite/.test(tag) || Math.abs(Math.round(D.nsv * 100) - Math.round(D.gsv * D.csw * 100)) <= 1) assert.ok(Math.abs(r.chkG) <= 0.01 && Math.abs(r.chkN) <= 0.01, tag + ': ajuste de cierre ≤ 0,01');
    if (!/gsv/.test(r.adj)) assert.equal(r.chkG, 0, tag + ': GSV = GOV×CTL sin ajuste');
  }
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
  // API MPMS 12.1.1 §14.2: cálculo en cadena, solo se redondea el resultado final
  // (el GOV redondeado no se reinserta en el cálculo del GSV ni del NSV).
  for (const s of [o, c]) {
    const raw = (s.tov - s.fwv) * s.ctsh;
    assert.equal(s.gsv, E.round(raw * s.ctl, 2), 'GSV debe calcularse con el GOV sin redondear');
    assert.equal(s.nsv, E.round(raw * s.ctl * s.csw, 2), 'NSV debe calcularse en cadena');
  }
  // Referencia de la Tabla 6A (API MPMS 11.1): 30,0 °API a 100 °F → 0,9821
  assert.equal(E.CTL(30, 100), 0.9821);
  const vols = [227.8, 235.57, 220.02, 233.35, 230.02, 238.91, 222.24, 231.13, 234.46, 226.69, 232.24];
  const p = E.prorate(D, vols.map((v, i) => ({ id: 'V' + i, vol: v })));
  assert.ok(p.ok, 'el prorrateo debe cuadrar con los totales del despacho');
  checkTickets(E, D, p, 'caso README');

  // Caso de la hoja Ctks_Prorrateo (bache de 9 carrotanques, crudo 17,2 °API, BSW 0,336 %).
  // Premisas: BSW y API iguales en todas las placas; solo varían T equivalente y CTL; Σ exactas.
  const csw = E.round((100 - 0.336) / 100, 5);
  const DX = { gov: 1985.08, gsv: 1922.71, csw, bswUsed: 0.336, nsv: E.round(1922.71 * csw, 2), api60: 17.2 };
  const placas = [['LPZ035', 233.99], ['WEQ631', 229.92], ['SVD130', 208.11], ['TTG443', 228.16], ['SSW708', 208.99],
    ['WWA694', 206.03], ['SWK550', 230], ['TSV111', 227.15], ['SPU787', 204.1]].map(([id, vol]) => ({ id, vol }));
  const px = E.prorate(DX, placas);
  assert.equal(px.t0, 142.5, 'T equivalente del despacho');
  assert.equal(px.ctl0, 0.96858, 'CTL del despacho a T equivalente');
  checkTickets(E, DX, px, 'Ctks_Prorrateo');
  assert.equal(px.tMaxDev, 1, 'desviación máxima de T por defecto: ±1,0 °F');
  assert.equal(px.tickets, placas.length, 'con ±1,0 °F (defecto) todos los tiquetes deben cuadrar sin ajuste');
  const pn = E.prorate(DX, placas, { tMaxDev: 0.5 });
  checkTickets(E, DX, pn, 'Ctks_Prorrateo ±0,5 °F');

  // Modo Lite: solo volúmenes, API y %BSW; T del líquido = T equivalente y su CTL.
  const L = E.liteDispatch({ gov: 1985.08, gsv: 1922.71, nsv: 1916.26, api60: 17.2, bsw: 0.336 });
  assert.ok(L.ok, 'Lite: datos válidos');
  assert.equal(L.csw, 0.99664, 'Lite: CSW');
  assert.equal(L.ctl, 0.96858, 'Lite: CTL efectivo');
  assert.equal(L.tEq, 142.5, 'Lite: T equivalente');
  assert.equal(L.ctlEq, 0.96858, 'Lite: CTL Tabla 6A a la T equivalente');
  assert.equal(L.warn.length, 0, 'Lite: sin alertas (NSV dentro de 0,01 y CTL exacto a 142,5 °F)');
  const pl = E.prorate(L, placas);
  checkTickets(E, L, pl, 'Lite Ctks_Prorrateo');
  assert.equal(pl.t0, L.tEq, 'Lite: la T del despacho del prorrateo es la T equivalente');
  assert.equal(Math.round(pl.sums.nsv.ajustado * 100), 191626, 'Lite: Σ NSV = NSV ingresado');
  // Lite con los totales del caso README: T equivalente = la del prorrateo del modo completo
  const LR = E.liteDispatch({ gov: D.gov, gsv: D.gsv, nsv: D.nsv, api60: 21.3, bsw: 0.35 });
  assert.ok(LR.ok && LR.tEq === p.t0 && LR.ctlEq === p.ctl0, 'Lite README: misma T equivalente y CTL que el modo completo');
  // NSV ingresado con %BSW redondeado: alerta y cierre exacto de todos modos
  const L2 = E.liteDispatch({ gov: 1985.08, gsv: 1922.71, nsv: 1915.20, api60: 17.2, bsw: 0.336 });
  assert.ok(L2.ok && L2.warn.some((w) => /BSW implícito/.test(w)), 'Lite: alerta por NSV ≠ GSV×CSW');
  const pl2 = E.prorate(L2, placas);
  assert.ok(pl2.ok, 'Lite: Σ cuadra aunque el NSV ingresado no sea GSV×CSW');
  assert.ok(pl2.rows.every((r) => r.bswA === 0.336 && r.apiA === 17.2), 'Lite: BSW y API únicos');
  // Validaciones
  assert.ok(!E.liteDispatch({ gov: 100, gsv: 99, nsv: 100, api60: 17, bsw: 0.5 }).ok, 'Lite: NSV > GSV es error');
  assert.ok(!E.liteDispatch({ gov: 100, gsv: 99, nsv: 98, api60: 120, bsw: 0.5 }).ok, 'Lite: API fuera de rango');
  assert.ok(!E.liteDispatch({ gov: 100, gsv: 99, nsv: 98, api60: 17, bsw: 120 }).ok, 'Lite: BSW fuera de rango');

  // Estrés: baches aleatorios de 1 a 16 vehículos.
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let z = 0; z < 300; z++) {
    const n = 1 + Math.floor(rnd() * 16);
    const v = Array.from({ length: n }, (_, i) => ({ id: 'V' + i, vol: E.round(150 + rnd() * 120, 2) }));
    const api = E.round(10 + rnd() * 40, 1), T = E.round(60 + rnd() * 120, 1);
    const gov = E.round(v.reduce((s, x) => s + x.vol, 0) * (0.97 + rnd() * 0.04), 2);
    const gsv = E.round(gov * E.CTL(api, T) * (0.997 + rnd() * 0.006), 2), b = E.round(rnd() * 2, 3), c = E.round((100 - b) / 100, 5);
    const DD = { gov, gsv, csw: c, bswUsed: b, nsv: E.round(gsv * c, 2), api60: api };
    checkTickets(E, DD, E.prorate(DD, v), 'estrés ' + z);
  }
  console.log(`OK ${file}: GOV ${D.gov} · GSV ${D.gsv} · NSV ${D.nsv}`);
}

run('index.html');
if (existsSync('dist/index.html')) run('dist/index.html');
