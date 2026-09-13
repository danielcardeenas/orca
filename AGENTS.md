# ORCA

## Estilo

Seguir el estilo existente de ORCA: reutilizar componentes, tipografías, colores,
espaciado y patrones actuales. Consultar DESIGN.md y la implementación existente
como referencia.

## Verificación

Antes de dar algo por terminado:

```
npm run typecheck
npm test -- --changed
```

`--changed` elige las suites que alcanzan lo que has tocado recorriendo el grafo
de imports y las rutas que las pruebas leen del disco (`new URL('../x',
import.meta.url)`, un directorio entero, o un `<link href="/src/…css">` en un
fixture de Playwright): cambiar `src/collector/provider-handoff.ts` corre 14
suites de 62; cambiar `src/ui/styles/hud.css`, 9. No hay lista que mantener y
no se desactualiza. La suite completa pasa de diez minutos, y por eso la
alternativa real a correr las suites afectadas no es correrlas todas: es no
correr ninguna.

Si aparece `sin suite que los cubra`, es un aviso, no un fallo: has cambiado algo
que ninguna prueba mira. Escribe la prueba, o di al entregar qué quedó sin
cubrir. Callarlo convierte «los tests pasan» en una frase sin contenido. Debajo
dice si lo mira un shot o una escena visual, que esta corrida no ejecuta.

Si no se ejecuta ninguna suite, la corrida sale con código 3, no en verde: «no
ejecuté nada» y «ejecuté y pasó» son cosas distintas. Las dos excepciones son
`--changed` con el árbol limpio, y haber tocado sólo documentación (Markdown
en `docs/` o en la raíz): ahí no hay nada que una suite pudiera mirar, y sale
con 0 diciéndolo.

Otras formas:

```
npm test                      las 62 suites
npm test -- capcom wake       suites cuyo nombre contiene alguno de los filtros
npm test -- --since=HEAD~1    contra una referencia de git
npm run visual                arnés visual, para cambios de UI
npm run shots                 los shots, de uno en uno; `-- hud` filtra por nombre
```

Un shot (`test/*.shots.ts`) abre la consola de verdad en Chromium y afirma sobre
lo que ve. `npm test` no los descubre —sólo mira `test/*.test.ts`— y
`npm run visual` corre sus propias escenas, así que hasta que existió
`npm run shots` sólo se corrían si alguien tecleaba el nombre del fichero de
memoria: `hud-improve.shots.ts` estuvo semanas en rojo con la suite en verde y
el panel de AUTOMEJORA sin red. Si tocas la UI, corre los que la miran y di
cuáles en la entrega; cada uno levanta su hub, su Vite y su flota, así que van
en serie y cuestan minutos, no segundos.

Al entregar, decir qué se corrió y qué salió. «Los tests pasan», sin decir
cuáles, no es verificación. Un fallo reportado a tiempo cuesta mucho menos que
uno que aparece cuando ya se construyó encima.

Cada documento de entrega en `docs/` termina listando los filtros que lo cubren;
mantener esa costumbre en las entregas nuevas.
