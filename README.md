# Oil Static Measure

Calculadora de medición estática de tanques (apertura y cierre) con prorrateo a carrotanques, y módulo de compensación volumétrica en oleoductos.

- Aplicación de una sola página: el código fuente es `index.html`. Al publicar, Vercel ejecuta `npm run build`, que genera `dist/index.html` con los scripts y estilos minificados y solo el aviso de copyright (`build.mjs`). Solo `dist/` queda público.
- Prueba del motor sobre la fuente y la versión publicada: `npm run build && npm test`.
- Cálculo: nivel adoptado (API MPMS 3), TOV por tabla de aforo, CTSh y GOV (API MPMS 12.1.1), CTL de crudo (API MPMS 11.1, Tabla 6A/24A), GSV, y volumen transferido de tanques de arrendamiento (API MPMS 12.1.1 §15.2.1): NSV = ΔGSV × CSW.
- Prorrateo por carrotanque con ajuste a cero: Σ GOV, GSV y NSV igualan los totales del despacho; %BSW y API del tanque iguales en todas las placas; por placa solo varían la temperatura equivalente y su CTL (Tabla 6A), de modo que cada tiquete se reproduce (GSV = GOV×CTL, NSV = GSV×CSW).
- Todos los datos incluidos son sintéticos y no pertenecen a ningún operador.
- Módulo **Oleoducto** (licenciable aparte): balance mensual por corriente de salida con N crudos, M puntos de entrada y J puntos de salida; pérdidas identificables y no identificables con tolerancia; contracción teórica por mezcla (API MPMS 12.3); compensación volumétrica por calidad (API y azufre, o valor contractual) de suma cero; factor de compensación volumétrica por producto, remitente y cliente; saldos over/short; importación y exportación Excel con fórmulas.
- Módulo **Balance de facilidad** (licenciable aparte, `facility`): balance diario de cantidad y calidad de una facilidad que recibe, procesa, autoconsume y despacha a carrotanques, oleoductos y buques. Producción teórica = Inv. final − Inv. inicial + Despachos + Autoconsumo + Pérdidas identificadas − Recibos de terceros; con producción medida, muestra la pérdida o ganancia no identificada frente a la tolerancia. Inventarios por tanque con la cadena de OilEngine (TOV por tabla de aforo o leído), despachos por medición estática (NSV apertura − NSV cierre, o ΔGSV × CSW según API MPMS 12.1.1 §15.2.1) y por tiquete; los carrotanques cargados durante el despacho de un tanque se descuentan de su destino principal. Acta imprimible, consolidado mensual con control de continuidad de inventarios y exportación a Excel. Se verificó al centésimo contra una planilla diaria real de balance de planta (los datos reales no se incluyen en el repositorio). Requiere la migración `supabase/migrations/003_balance_facilidad.sql`.
- Pestaña **Organización**: organizaciones y licencias por módulo (estática, oleoducto o total), con usuarios y vencimiento. Con sesión se guardan en Supabase y la base las hace cumplir (RLS); en «Ver demostración» se guardan solo en el navegador. El administrador de la plataforma da de alta a un cliente así: crea la organización, guarda su licencia y, en «Dar acceso a un cliente», invita al propietario, que luego invita a su equipo hasta el cupo de la licencia. `docs/schema-saas-multitenant.sql` es un borrador anterior del modelo de datos del oleoducto.

- **Página de producto** en `/producto` (`producto.html`, sin scripts): presenta los módulos, la trazabilidad y las licencias, con botones de demostración y cotización por correo. El correo de contacto está en los enlaces `mailto:` del archivo.

## Caso de prueba sintético

Tanque "TK001" (D = 28,5 m, fondo muerto 120 bbl). Apertura: 10 420 mm, 153,4 °F, API 21,3, BSW 0,35 %. Cierre: 9 790 mm, 152,9 °F.

Resultado esperado del despacho: GOV 2 532,43 · GSV 2 428,89 · CSW 0,99650 · NSV 2 420,39 bbl.

Oleoducto (botón "Cargar ejemplo"): 3 puntos de entrada, 2 de salida, 4 remitentes, 4 crudos (34; 24; 16 y 12,5 °API), 2 corrientes. Mezcla Exportación: PNI 772,00 bbl (0,1499 %), API de mezcla 20,5, valor del pool 66,780303 USD/bbl, ΔV de Andina Oil +9 408,07 bbl. Mezcla Refinería: PNI 950 bbl sobre la tolerancia de 900 bbl (50 bbl los asume el transportador).

## Derechos de autor

© 2026 Juan Cohen. Todos los derechos reservados. Software propietario: ver `LICENSE`. No se autoriza su copia, modificación ni distribución sin permiso escrito del autor.

## Seguridad (backend en Supabase)

- **Solo por invitación.** Un disparador en `auth.users` rechaza cualquier registro sin invitación vigente. La membresía se crea solo cuando el invitado confirma su correo, con el nombre que puso quien invitó (no el que escribe el usuario).
- **Segundo factor obligatorio (TOTP).** Una política restrictiva en todas las tablas exige sesión `aal2`; con solo la contraseña no se ve ni se escribe nada.
- **Aislamiento por organización, rol y licencia** con Row Level Security. El rol `anon` no tiene permisos. Roles: visor, analista, administrador, propietario; nadie asigna un rol mayor que el propio.
- **El administrador de la plataforma** gestiona organizaciones y licencias, pero no puede leer los datos de organizaciones de las que no es miembro.
- **Anti-suplantación y trazabilidad.** El servidor fija usuario, nombre y fecha en cada cambio. La auditoría es una cadena SHA-256 de solo inserción, y cada documento guarda su versión anterior en un historial inalterable. Un período cerrado no se borra.
- **Navegador.** No se usan librerías de terceros para la sesión. El token de acceso vive en memoria y el de renovación en `sessionStorage`. La sesión se cierra tras 30 minutos de inactividad.
  - CSP con la huella SHA-256 de cada script y conexiones solo al proyecto de Supabase.
  - Cabeceras HSTS, `frame-ancestors 'none'` y `X-Frame-Options`.
- El esquema está en `supabase/migrations/`. La clave publicable del sitio es pública por diseño. La clave de servicio nunca va en el código.

Sin cuenta, "Ver demostración" funciona solo en el navegador del visitante, con datos de ejemplo y sin acceso a la base.

## Aviso

Valide los resultados con su procedimiento y las ediciones vigentes de las normas API/ASTM antes de uso comercial o fiscal.
