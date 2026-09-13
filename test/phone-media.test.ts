/**
 * Un teléfono es un teléfono también de lado, y lo dice UN sitio.
 *
 * `src/ui/phone.ts` tiene la condición; `hud.css` y `window.css` la repiten,
 * porque `@media` no puede importarla. Tres copias de la misma pregunta es
 * exactamente lo que se rompió: el gestor de ventanas decía `max-width: 720px`,
 * la hoja de ventanas decía lo mismo para vestir y `(max-width: 720px) and
 * (max-height: 560px)` para el apaisado —una condición que no cumple ningún
 * teléfono de 844 o más girado, o sea ninguno de hoy—, y el mástil ya había
 * añadido el alto. Un tamaño que cumplía una copia y no otra salía vestido de
 * teléfono y tratado como escritorio, o al revés.
 *
 * Aquí no se comparan cadenas: dos condiciones pueden decir lo mismo con otro
 * orden. Se evalúan sobre una malla de tamaños y se exige la misma tabla de
 * verdad. Con eso, cambiar la condición en un sitio y no en los otros pone
 * esta suite en rojo, y eso es todo lo que se le pide.
 *
 * `npm test -- --changed` sólo sigue imports de `.ts`, así que tocar sólo una
 * hoja CSS no la selecciona: `npm test -- phone` la corre por nombre.
 */

import { readFileSync } from 'node:fs';
import { PHONE_LANDSCAPE_MQ, PHONE_MQ } from '../src/ui/phone.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const STYLES = new URL('../src/ui/styles/', import.meta.url);
const SHEETS = ['hud.css', 'window.css'];

/**
 * Lo mínimo que hace falta para evaluar estas condiciones: `max-width`,
 * `max-height`, `pointer: coarse`, `and`, la coma y los paréntesis. Cualquier
 * otra cosa es un error, no un «no sé»: una condición que este evaluador no
 * entiende es una condición que nadie ha mirado.
 */
type Env = { w: number; h: number; coarse: boolean };
function compile(mq: string): (e: Env) => boolean {
  const expr = mq
    .replace(/\(max-width:\s*(\d+)px\)/g, '(e.w<=$1)')
    .replace(/\(max-height:\s*(\d+)px\)/g, '(e.h<=$1)')
    .replace(/\(pointer:\s*coarse\)/g, '(e.coarse)')
    .replace(/\band\b/g, '&&')
    .replace(/,/g, '||');
  if (!/^[\se.whcoarse0-9<=&|()]+$/.test(expr)) throw new Error(`media query fuera del evaluador: ${mq}`);
  return new Function('e', `return !!(${expr});`) as (e: Env) => boolean;
}

/** Todas las `@media` de una hoja que hablan de teléfono: las que llevan alguno de sus dos umbrales. */
function phoneQueries(sheet: string): string[] {
  const css = readFileSync(new URL(sheet, STYLES), 'utf8');
  const out: string[] = [];
  for (const m of css.matchAll(/@media\s+([^{]+)\{/g)) {
    const q = m[1]!.trim();
    if (/\b720px\b|\b560px\b/.test(q)) out.push(q);
  }
  return out;
}

/** La malla: todo lo que un teléfono, una tableta o una ventana encogida puede medir. */
const GRID: Env[] = [];
for (let w = 300; w <= 1500; w += 20) for (let h = 300; h <= 1100; h += 20) GRID.push({ w, h, coarse: true }, { w, h, coarse: false });

function table(fn: (e: Env) => boolean): string {
  return GRID.map((e) => (fn(e) ? '1' : '0')).join('');
}

/** Con el dedo delante: cada rama de `mq` con `(pointer: coarse) and`. */
function withFinger(mq: string): string {
  return mq.split(/,(?![^(]*\))/).map((b) => `(pointer: coarse) and ${b.trim()}`).join(', ');
}

const phone = compile(PHONE_MQ);
const landscape = compile(PHONE_LANDSCAPE_MQ);
const allowed = new Map<string, string>([
  ['PHONE_MQ', table(phone)],
  ['PHONE_LANDSCAPE_MQ', table(landscape)],
  ['(pointer: coarse) and PHONE_MQ', table(compile(withFinger(PHONE_MQ)))],
  ['(pointer: coarse) and PHONE_LANDSCAPE_MQ', table(compile(withFinger(PHONE_LANDSCAPE_MQ)))],
]);

/** Teléfonos de referencia, de pie y de lado, y lo que no es un teléfono. */
const PHONES: [number, number][] = [[390, 844], [844, 390], [926, 428], [428, 926], [360, 640], [640, 360], [430, 932], [932, 430]];
/** Los de hoy, de lado: todo iPhone desde el X y los Android grandes miden 844 o más girados. */
const TODAY_LANDSCAPE: [number, number][] = [[844, 390], [926, 428], [932, 430], [852, 393]];
const NOT_PHONES: [number, number][] = [[1440, 900], [1000, 900], [800, 600], [1200, 818], [1181, 560], [721, 561], [1024, 768]];

const tests = [
  ...PHONES.map(([w, h]) => test(`teléfono: ${w}×${h}`, () =>
    ok(`teléfono: ${w}×${h}`, phone({ w, h, coarse: true }), PHONE_MQ))),
  ...NOT_PHONES.map(([w, h]) => test(`no es un teléfono: ${w}×${h}`, () =>
    ok(`no es un teléfono: ${w}×${h}`, !phone({ w, h, coarse: true }), PHONE_MQ))),

  test('de lado es la mitad corta de la condición entera', () => {
    const inside = GRID.every((e) => !landscape(e) || phone(e));
    return ok('de lado es la mitad corta de la condición entera', inside, PHONE_LANDSCAPE_MQ);
  }),

  // El hallazgo, escrito para que no vuelva: la condición que había en
  // `window.css` para el apaisado pedía el ancho de un teléfono de pie y el
  // alto de uno de lado a la vez. Sólo entraban los de 720 o menos girados —un
  // Android de 360 (640×360), un 4,7" (667×375)—; ninguno de los de hoy. Esta
  // misma suite lo corrigió: decía «ningún teléfono» y 640×360 la desmintió.
  test('la condición vieja del apaisado no describía ningún teléfono de hoy', () => {
    const old = compile('(max-width: 720px) and (max-height: 560px)');
    const hits = TODAY_LANDSCAPE.filter(([w, h]) => old({ w, h, coarse: true }));
    const small = old({ w: 640, h: 360, coarse: true });
    return eq('la condición vieja del apaisado no describía ningún teléfono de hoy', hits, [], small ? 'sólo 640×360 y menores' : 'ni siquiera 640×360');
  }),

  ...SHEETS.map((sheet) => test(`${sheet}: cada bloque de teléfono dice lo que dice phone.ts`, () => {
    const queries = phoneQueries(sheet);
    if (queries.length === 0) return ok(`${sheet}: cada bloque de teléfono dice lo que dice phone.ts`, false, 'no hay ningún bloque de teléfono en la hoja');
    const strays = queries.filter((q) => ![...allowed.values()].includes(table(compile(q))));
    return eq(`${sheet}: cada bloque de teléfono dice lo que dice phone.ts`, strays, [], `${queries.length} bloque(s)`);
  })),
];

const suite: TestModule = { suite: 'contrato · un teléfono es un teléfono también de lado', tests };
export default suite;
