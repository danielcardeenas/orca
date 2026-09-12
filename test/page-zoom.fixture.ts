/**
 * El zoom nativo apagado, y el propio intacto.
 *
 * Los estilos entran por `import` y no por un `<link>` en el HTML de la
 * prueba a propósito: así el grafo de imports que elige las suites afectadas
 * (`test/affected.ts`) ve que esta suite cubre `tokens.css` y `strays.css`.
 * Un `<link>` funciona igual en el navegador y no lo ve nadie.
 */
import '../src/ui/styles/tokens.css';
import '../src/ui/styles/field.css';
import '../src/ui/styles/strays.css';
import { lockPageZoom } from '../src/ui/zoom-lock.ts';
import { share, spend, wheelPixels } from '../src/ui/windows/chain.ts';

lockPageZoom();

document.body.innerHTML = `
  <div class="field" data-field></div>
  <div class="hud" data-hud><button class="tool" type="button">TOOL</button></div>
  <div data-pane style="width:120px;height:120px"><i data-img style="display:block;width:100%;height:100%"></i></div>
  <div class="hyg__stray-list" data-strays><div data-tall style="height:900px"></div></div>
  <div data-box style="height:100px;overflow:auto"><div style="height:400px"></div></div>`;

/** Pellizcos que el visor de imágenes se queda para sí. */
export const pinched = { pane: 0 };

/*
 * El patrón del visor (`windows/kinds/file.ts`): el pellizco sobre la imagen
 * es de la imagen, así que lo para en seco — `preventDefault` y
 * `stopPropagation` — para que no zoome además el campo de debajo. La barrera
 * global tiene que convivir con esto: si lo rompiera, la solución está mal.
 */
document.querySelector('[data-pane]')!.addEventListener('wheel', (e) => {
  const w = e as WheelEvent;
  if (!w.ctrlKey && !w.metaKey) return;
  e.preventDefault(); e.stopPropagation();
  pinched.pane++;
}, { passive: false });

export { share, spend, wheelPixels };
