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
de imports: cambiar `src/collector/provider-handoff.ts` corre 14 suites de 62;
cambiar `src/ui/field/pipes.ts`, 3. No hay lista que mantener y no se
desactualiza. La suite completa pasa de diez minutos, y por eso la alternativa
real a correr las suites afectadas no es correrlas todas: es no correr ninguna.

Si aparece `sin suite que los cubra`, es un aviso, no un fallo: has cambiado algo
que ninguna prueba mira. Escribe la prueba, o di al entregar qué quedó sin
cubrir. Callarlo convierte «los tests pasan» en una frase sin contenido.

Otras formas:

```
npm test                      las 62 suites
npm test -- capcom wake       suites cuyo nombre contiene alguno de los filtros
npm test -- --since=HEAD~1    contra una referencia de git
npm run visual                arnés visual, para cambios de UI
```

Al entregar, decir qué se corrió y qué salió. «Los tests pasan», sin decir
cuáles, no es verificación. Un fallo reportado a tiempo cuesta mucho menos que
uno que aparece cuando ya se construyó encima.

Cada documento de entrega en `docs/` termina listando los filtros que lo cubren;
mantener esa costumbre en las entregas nuevas.
