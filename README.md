# Oil Static Measure

Calculadora de medición estática de tanques (apertura y cierre) con prorrateo a carrotanques, y módulo de compensación volumétrica en oleoductos.

- Aplicación de una sola página: el código fuente es `index.html`. Al publicar, Vercel ejecuta `npm run build`, que genera `dist/index.html` con los scripts y estilos minificados y solo el aviso de copyright (`build.mjs`). Solo `dist/` queda público.
- Prueba del motor sobre la fuente y la versión publicada: `npm run build && npm test`.
- Cálculo: nivel adoptado (API MPMS 3), TOV por tabla de aforo, CTSh y GOV (API MPMS 12.1.1), CTL de crudo (API MPMS 11.1, Tabla 6A/24A), GSV, y volumen transferido de tanques de arrendamiento (API MPMS 12.1.1 §15.2.1): NSV = ΔGSV × CSW.
- Prorrateo por carrotanque con ajuste a cero y chequeo de que las sumas de GOV, GSV y NSV igualan los totales del despacho.
- Todos los datos incluidos son sintéticos y no pertenecen a ningún operador.
- Módulo **Oleoducto** (licenciable aparte): balance mensual por corriente de salida con N crudos, M puntos de entrada y J puntos de salida; pérdidas identificables y no identificables con tolerancia; contracción teórica por mezcla (API MPMS 12.3); compensación volumétrica por calidad (API y azufre, o valor contractual) de suma cero; factor de compensación volumétrica por producto, remitente y cliente; saldos over/short; importación y exportación Excel con fórmulas.
- Pestaña **Organización**: organizaciones y licencias por módulo (estática, oleoducto o total). En esta versión se guardan en el navegador; el esquema para producción con aislamiento por organización está en `docs/schema-saas-multitenant.sql`.

## Caso de prueba sintético

Tanque "TK001" (D = 28,5 m, fondo muerto 120 bbl). Apertura: 10 420 mm, 153,4 °F, API 21,3, BSW 0,35 %. Cierre: 9 790 mm, 152,9 °F.

Resultado esperado del despacho: GOV 2 532,43 · GSV 2 428,89 · CSW 0,99650 · NSV 2 420,39 bbl.

Oleoducto (botón "Cargar ejemplo"): 3 puntos de entrada, 2 de salida, 4 remitentes, 4 crudos (34; 24; 16 y 12,5 °API), 2 corrientes. Mezcla Exportación: PNI 772,00 bbl (0,1499 %), API de mezcla 20,5, valor del pool 66,780303 USD/bbl, ΔV de Andina Oil +9 408,07 bbl. Mezcla Refinería: PNI 950 bbl sobre la tolerancia de 900 bbl (50 bbl los asume el transportador).

## Derechos de autor

© 2026 Juan Cohen. Todos los derechos reservados. Software propietario: ver `LICENSE`. No se autoriza su copia, modificación ni distribución sin permiso escrito del autor.

## Aviso

Los datos se guardan en el navegador de cada usuario. No hay autenticación ni base de datos compartida en esta versión. Valide los resultados con su procedimiento y las ediciones vigentes de las normas API/ASTM antes de uso comercial o fiscal.
