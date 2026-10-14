# Oil Static Measure

Calculadora de medición estática de tanques (apertura y cierre) con prorrateo a carrotanques.

- Aplicación de una sola página: el código fuente es `index.html`. Al publicar, Vercel ejecuta `npm run build`, que genera `dist/index.html` con los scripts y estilos minificados y solo el aviso de copyright (`build.mjs`). Solo `dist/` queda público.
- Prueba del motor sobre la fuente y la versión publicada: `npm run build && npm test`.
- Cálculo: nivel adoptado (API MPMS 3), TOV por tabla de aforo, CTSh y GOV (API MPMS 12.1.1), CTL de crudo (API MPMS 11.1, Tabla 6A/24A), GSV, y volumen transferido de tanques de arrendamiento (API MPMS 12.1.1 §15.2.1): NSV = ΔGSV × CSW.
- Prorrateo por carrotanque con ajuste a cero y chequeo de que las sumas de GOV, GSV y NSV igualan los totales del despacho.
- Todos los datos incluidos son sintéticos y no pertenecen a ningún operador.

## Caso de prueba sintético

Tanque "TK001" (D = 28,5 m, fondo muerto 120 bbl). Apertura: 10 420 mm, 153,4 °F, API 21,3, BSW 0,35 %. Cierre: 9 790 mm, 152,9 °F.

Resultado esperado del despacho: GOV 2 532,43 · GSV 2 428,89 · CSW 0,99650 · NSV 2 420,39 bbl.

## Derechos de autor

© 2026 Juan Cohen. Todos los derechos reservados. Software propietario: ver `LICENSE`. No se autoriza su copia, modificación ni distribución sin permiso escrito del autor.

## Aviso

Los datos se guardan en el navegador de cada usuario. No hay autenticación ni base de datos compartida en esta versión. Valide los resultados con su procedimiento y las ediciones vigentes de las normas API/ASTM antes de uso comercial o fiscal.
