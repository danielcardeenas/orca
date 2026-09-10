# Rutas fuera de los proyectos en el visor de archivos

Un agente deja una comparación en `~/Desktop/dijosi-logos/colores/grid3.png`
y la cita en su conversación. El operador la pincha y el visor contesta
`HTTP 403 · OUTSIDE THE PROJECT ROOTS`: el Escritorio no es un proyecto, ni
el scratchpad, ni una carpeta de `ORCA_FILE_ROOTS`. Hasta hoy la salida era
editar el entorno y reiniciar el hub.

Ahora el visor, debajo del 403, ofrece un botón `ALLOW ~/Desktop/dijosi-logos/colores`.
Una pulsación autoriza esa carpeta en el hub, la ventana vuelve a cargar y la
imagen aparece. La carpeta queda en `~/.orca/hub/file-roots.json`, así que
un reinicio no la olvida y todos los archivos que caigan en ella se abren
desde entonces sin volver a pedirlo.

## Cómo viaja

1. El visor manda `{ k: 'files:allow', path }` por el socket de la consola,
   con la ruta del archivo que no pudo ver.
2. El hub (`src/hub/file-roots.ts`) resuelve `~`, exige ruta absoluta, mira
   el disco: si es una carpeta se autoriza tal cual; si es un archivo, su
   carpeta. La misma `acceptableRoot` de `files.ts` decide si puede ser
   raíz: la home entera no, un contenedor temporal no, una ruta privada con
   nombre conocido (`.ssh`, `.env`, claves) no, y `~/.orca` tampoco.
3. La lista se guarda con temporal y `rename`, y entra en las raíces de
   `/api/file` en la petición siguiente. `resolveServedPath` vuelve a
   contener cada petición contra cada raíz: autorizar una carpeta no salta
   ninguna de las puertas que ya había (symlinks hacia fuera, `..`, archivos
   de otro usuario, techo de tamaño).
4. El ack trae la raíz que quedó. Si ya estaba cubierta por otra, lo dice y
   no duplica; una carpeta nueva que contiene a otras las absorbe. Techo de
   64 carpetas.

Revocar es quitar la línea del json y reiniciar el hub. No hay comando para
ello a propósito: nadie lo ha necesitado, y un comando que nadie usa es una
puerta más que vigilar.

## Dónde vive

- `src/hub/file-roots.ts`: la lista, sus reglas y su persistencia.
- `src/hub/server.ts`: el comando `files:allow` se resuelve en el hub y no
  se enruta a ningún collector; `serveFile` suma las carpetas autorizadas.
  La opción `fileRootsFile` de `startHub` apunta a otro json en pruebas y a
  ninguno en el arnés, que no toca el disco del operador.
- `src/shared/protocol.ts`: el comando, documentado en el `Command`.
- `src/ui/windows/kinds/file.ts`: el botón bajo el 403, sólo con enlace al
  hub; deshabilitado mientras espera el ack; recarga al conseguirlo.
- `src/shared/hygiene.ts`: `~/.orca/hub/file-roots.json` protegido de la
  limpieza, como el resto de la configuración del hub.

## Lo que no hace

- **Dos Macs.** La carpeta se autoriza en el disco del hub. Un archivo que
  vive en el otro Mac sigue sin verse, igual que antes: `/api/file` lee del
  disco del hub (`docs/FLEET-MULTI-MAC.md`).
- **Sin lista en la consola.** Qué carpetas están autorizadas se lee en el
  json; no hay ventana que las enseñe ni botón que las quite.

## Verificación

`npm run typecheck` limpio. `npm test -- files file-roots hub commands`:
76/76. `file-roots` prueba que un archivo autoriza su carpeta y una carpeta
se autoriza tal cual, que la home, `.ssh`, `~/.orca`, `/tmp`, una relativa
y una inexistente se rechazan, que un archivo suelto en la home no abre la
home, la absorción y el no duplicado, el techo, y que un json roto o ajeno
arranca vacío. `files` añade la prueba de punta a punta: 403 antes, ack con
la raíz, 200 con el contenido después, la home rechazada por el mismo
comando, y un segundo hub con el mismo json que sirve la carpeta y sigue
negando un `..`.

Sin cobertura automática ni prueba manual: el botón en el visor
(`file.ts`) sólo pasó el typecheck. Queda por pulsarlo en la consola viva
con un 403 real.

Filtros que cubren esta entrega: `file-roots`, `files`, `hub`, `commands`.
