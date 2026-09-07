# Temporales en el visor de archivos

Verificación local: 2026-09-06, usuario del hub UID 501. Se inspeccionaron
nombres y metadatos, sin abrir contenidos de temporales existentes.

## Rutas cubiertas

- `/private/tmp/claude-501` existe, pertenece a UID 501 y tiene modo 0700.
  `/tmp/claude-501` es su alias real mediante `/tmp -> /private/tmp`.
- `$TMPDIR/claude-501` se admite cuando exista como directorio del usuario
  del hub y no sea un symlink. El TMPDIR observado es
  `/var/folders/z0/hnljtxdx78jchvhd9srjfsdw0000gn/T/`, cuya forma canónica es
  `/private/var/folders/z0/hnljtxdx78jchvhd9srjfsdw0000gn/T/`.
  No se encontró `claude-501` allí durante la inspección.
- Las raíces autorizadas admiten su ruta declarada, su `realpath` y sus aliases
  macOS `/tmp` y `/var` sólo cuando se comprueba que resuelven a la misma raíz.
- Los proyectos y las raíces explícitas de `ORCA_FILE_ROOTS` siguen disponibles.
  Una entrada puede ser un archivo concreto: no autoriza sus hermanos.

No se añadió otra raíz automática: la inspección no lo justificó.
`/private/temp` no existe y no se inventa como alias. El directorio
`/private/tmp/claude-mcp-browser-bridge-danielcardenas` y los directorios
`com.anthropic.claudefordesktop.ShipIt.*` del TMPDIR no se incorporan.

## Límites

No se aceptan como raíces `/private`, `/var`, `/private/var`, `/tmp`,
`/private/tmp`, `/private/temp`, `/var/tmp`, `/private/var/tmp`, el TMPDIR
completo ni los contenedores de `/var/folders` y `/private/var/folders`.
La misma validación se aplica después de resolver symlinks en las raíces.

Se exige contención por `realpath`, archivo regular y propiedad del usuario
del hub tanto en la raíz existente como en el archivo (en sistemas con UID).
Se rechazan scratchpads `claude-<otro UID>`, symlinks escapados, directorios,
FIFO y demás archivos especiales. Se conserva el límite de 16 MiB.

Se excluyen nombres privados conocidos antes y después de `realpath`:
`.ssh`, `.aws`, `.azure`, `.config`, `.gnupg`, `.kube`, `.claude`, `.codex`,
`.docker`, `.git`, `.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.claude.json`,
`credentials`, `secret`/`secrets` con sus extensiones, claves SSH conocidas,
archivos PEM/KEY/P12/PFX/keychain, `.orca/token`, `.orca/config*` y `/etc`
incluido su alias `/private/etc`. Esta política también afecta a proyectos
y autorizaciones explícitas. No inspecciona contenidos ni detecta secretos
renombrados arbitrariamente: sólo se deben autorizar artefactos revisados.

El HTML y SVG conservan CSP `sandbox`; el transporte conserva `nosniff`,
`no-store`, HEAD y rangos para media. No se modificaron el linkificador ni el visor.

## Activación

1. Incorporar estos cambios en el siguiente arranque autorizado del hub.
   Esta tarea no reinició el hub ni el collector real.
2. Mantener `ORCA_STRICT_AUTH=1` o un `ORCA_TOKEN` configurado, y conectar la
   consola con ese token. El endpoint conserva la política de autenticación
   existente: sin ambas variables, el modo desarrollo permite loopback sin token.
3. Las raíces scratchpad propias se comprueban en cada petición, sin agregar
   configuración. Para un artefacto suelto revisado, configurar por ejemplo
   `ORCA_FILE_ROOTS=/private/tmp/entrega-revisada.png`, o una subcarpeta concreta
   revisada, en el entorno del próximo arranque. No autorizar el padre temporal.
   Las entradas se separan con `:`; preservar las autorizaciones previas pertinentes.
4. Abrir la ruta linkificada en la consola autenticada.

## Evidencia reproducible

```sh
ORCA_HOME=$(mktemp -d /tmp/orca-task02-hub-XXXXXX) npm test -- files
```

Resultado: **34/34**. Hub de prueba en loopback y puerto libre, token sintético,
almacenamiento del hub separado por `ORCA_HOME` y fixtures con nombres únicos.
Incluye rutas declaradas/canónicas, alias inverso real de macOS, scratchpad
TMPDIR, autorización de archivo único, texto, PNG, HTML/CSP, HEAD, audio/vídeo
por Range, 401 sin token/incorrecto, 403 de rutas privadas/escapes/otro usuario,
404 de FIFO/directorio/ausente y 413 por tamaño.
Media usa bytes sintéticos para verificar el contrato HTTP; no acredita
decodificación audiovisual ni una revisión visual en navegador.
No se borran fixtures ni archivos preexistentes.

`npm run typecheck`: **correcto en la comprobación final**. Una pasada anterior
encontró errores de higiene en edición compartida (`estimated`/`Confidence`),
comunicados al equipo y ya ausentes al cerrar la tarea.
