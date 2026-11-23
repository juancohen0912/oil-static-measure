// Prueba del módulo Balance de facilidad (FacilityEngine) sobre index.html y dist/index.html.
// Datos sintéticos (FacilityEngine.demo y casos construidos aquí); ningún dato de operadores reales.
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

function load(file) {
  const sc = [...readFileSync(file, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const ctx = vm.createContext({}); ctx.globalThis = ctx; ctx.window = ctx;
  vm.runInContext(sc[0], ctx);
  const fac = sc.find((s) => s.includes('FacilityEngine') && s.includes('Medidores de fiscalizaci'));
  assert.ok(fac, file + ': no se encontró el motor del balance de facilidad');
  vm.runInContext(fac, ctx);
  return { E: ctx.OilEngine, F: ctx.FacilityEngine };
}
const c = (x) => Math.round(x * 100);

function run(file) {
  const { E, F } = load(file);
  // 1) Ejemplo: cuadra y la ecuación se cumple al centésimo.
  const r = F.compute(F.demo(), E, () => null);
  assert.ok(r.ok, 'el ejemplo no debe tener errores: ' + r.err.join(' | '));
  const b = r.bal;
  assert.equal(c(b.teo), c(b.fin) - c(b.ini) + c(b.desp) + c(b.cons) + c(b.loss) - c(b.rec), 'ecuación de producción teórica');
  assert.equal(b.check, 0, 'cuadre de cierre');
  assert.equal(c(b.desp), Object.values(r.by).reduce((s, x) => s + c(x.nsv), 0), 'despachos = Σ por destino');
  assert.ok(b.inTol, 'el ejemplo queda dentro de la tolerancia');
  // Cada NSV de inventario reproduce la cadena de OilEngine.
  for (const x of r.ini.rows) assert.equal(x.nsv, E.round((x.tov - x.fwv) * x.ctsh * x.ctl * x.csw, 2), 'NSV ' + x.tank);
  // Carrotanques del TK-202 cargados durante su despacho a oleoducto: oleoducto = movimiento − carrotanques.
  const m = r.moves.find((x) => x.tank === 'TK-202');
  assert.equal(c(m.main.nsv), c(m.nsv) - c(m.linked.nsv));
  assert.equal(m.linked.n, 3);

  // 2) Caso a mano: un tanque, despacho estático con TOV dado, un carrotanque de otro tanque sin movimiento.
  const meas = (tov) => ({ tov: String(tov), fwv: '0', tl: '150', ta: '80', api: '20', bsw: '0.5' });
  const d = { cfg: { tolPct: '0.5' }, tanks: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }],
    invIni: [Object.assign({ tank: 'A' }, meas(10000)), Object.assign({ tank: 'B' }, meas(2000))],
    invFin: [Object.assign({ tank: 'A' }, meas(6000)), Object.assign({ tank: 'B' }, meas(1800))],
    moves: [{ tank: 'A', dest: 'oleoducto', open: meas(10000), close: { tov: '6000', fwv: '0', tl: '150', ta: '80' } }],
    tickets: [{ dest: 'carrotanques', tank: 'B', ref: 'X', gsv: '199', nsv: '198.00', bsw: '0.5' }], rec: [], prod: [], cons: [], loss: [] };
  const r2 = F.compute(d, E, () => null);
  assert.ok(r2.ok, r2.err.join(' | '));
  const ia = r2.ini.rows[0], fa = r2.fin.rows[0];
  assert.equal(r2.moves[0].nsv, E.round(ia.nsv - fa.nsv, 2), 'NSV despachado = NSV apertura − NSV cierre');
  assert.equal(r2.by.carrotanques.nsv, 198, 'tiquete de un tanque sin despacho estático se suma');
  assert.equal(c(r2.bal.teo), c(r2.bal.fin) - c(r2.bal.ini) + c(r2.bal.desp), 'producción teórica sin recibos ni consumos');
  // Modo API MPMS 12.1.1 §15.2.1: difiere a lo sumo en centésimas.
  d.cfg.nsvMode = 'gsv_csw';
  const r3 = F.compute(d, E, () => null);
  assert.ok(Math.abs(r3.moves[0].nsv - r2.moves[0].nsv) <= 0.02, 'ΔGSV×CSW vs diferencia de NSV');
  // Errores claros: tiquetes que superan el movimiento.
  d.cfg.nsvMode = 'nsv_diff'; d.tickets = [{ dest: 'carrotanques', tank: 'A', nsv: '999999' }];
  assert.ok(!F.compute(d, E, () => null).ok, 'tiquetes mayores que el movimiento deben dar error');
  // Día siguiente: el inventario final pasa a inicial.
  const nx = F.nextDay(F.demo());
  assert.deepEqual(nx.invIni.map((x) => x.tov), F.demo().invFin.map((x) => x.tov));
  // Consolidado: detecta saltos de inventario entre días.
  const cons = F.consolidate([{ date: '2026-11-02', summary: { ini: 100, fin: 90, teo: 5 } }, { date: '2026-11-01', summary: { ini: 80, fin: 100, teo: 5 } }, { date: '2026-11-03', summary: { ini: 91, fin: 95, teo: 5 } }]);
  assert.equal(cons.gaps.length, 1); assert.equal(cons.gaps[0].date, '2026-11-03'); assert.equal(cons.tot.teo, 15);
  console.log(`OK ${file}: balance de facilidad · teórica ${b.teo} · diferencia ${b.pct} % · 6 tanques`);
}
run('index.html');
if (existsSync('dist/index.html')) run('dist/index.html');
