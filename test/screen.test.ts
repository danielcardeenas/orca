/**
 * Lo que la pantalla de un pane dice: prompts de permisos y de confianza.
 *
 * Las pantallas de aquí son capturas reales de Claude Code 2.1.261, recortadas.
 * Si el CLI cambia el texto, estos tests avisan antes que un agente colgado.
 */

import { promptOn } from '../src/collector/screen.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

const PERMISSION = `
│   echo "=== stat -f %z ==="; stat -f %z "$OUT"
│   echo "=== DONE ==="
  ping_pong_papas.jpg generation and verification

Contains shell syntax (string) that cannot be statically analyzed

Do you want to proceed?
❯ 1. Yes
  2. No
`;

const TRUST = `
 Accessing workspace:
 /Users/dan/.orca/capcom
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;

/** El diálogo de cuatro opciones del 2.1.261, con su relleno. */
const PERMISSION4 = `
   │ python3 - <<'EOF'
   │ print('probe')
   │ EOF
   Run python3 heredoc that prints a probe line
 This command requires approval
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: python3 *
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend
`;

const WORKING = `
❯ Generate ping pong papas JPEG
⏺ Bash(python3 - <<'EOF' …)
  ⎿  Running…
`;

/** Un prompt ya contestado queda en el historial: no debe contar. */
const ANSWERED = `
Do you want to proceed?
❯ 1. Yes
  2. No
⏺ Bash(magick -size 1200x600 xc:white …)
  ⎿  === DONE ===
⏺ Generated ping_pong_papas.jpg (48 KB).
✻ Baked for 12s · done 12:20 AM
❯
`;

const tests = [
  test('a permission dialog is seen, with the line the CLI put above it', () => {
    const p = promptOn(PERMISSION);
    return ok(
      'a permission dialog is seen',
      p?.kind === 'permission' && p.summary.startsWith('Contains shell syntax (string) that cannot be statically analyzed'),
      JSON.stringify(p),
    );
  }),

  test('the four-option dialog names the command, not the boilerplate above it', () => {
    return eq('the four-option dialog names the command', promptOn(PERMISSION4)?.summary, '[request details omitted; inspect terminal]\nCommand: python3 [arguments omitted; inspect terminal]');
  }),

  test('the folder-trust dialog is told apart from a tool prompt', () => {
    return eq('the folder-trust dialog is told apart', promptOn(TRUST)?.kind, 'trust');
  }),

  test('a working screen, and a prompt already answered, are not prompts', () => {
    return ok(
      'a working screen and an answered prompt are not prompts',
      promptOn(WORKING) === null && promptOn(ANSWERED, 8) === null,
      `working=${JSON.stringify(promptOn(WORKING))} answered=${JSON.stringify(promptOn(ANSWERED, 8))}`,
    );
  }),
];

const suite: TestModule = { suite: 'screen · lo que dice la pantalla de un pane', tests };
export default suite;
