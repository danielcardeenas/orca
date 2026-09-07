import { esc, tokens } from '../util.ts';
import { stepLabel, type TalkStep } from './talk.ts';

/** Shared disclosure markup for CAPCOM and agent conversations. */
export function talkStepHtml(step: TalkStep, open = false): string {
  if (step.kind === 'thinking') {
    const has = step.text.trim().length > 0;
    return `<details class="talk__step is-thinking" data-step="${esc(step.id)}"${open && has ? ' open' : ''}${has ? '' : ' data-empty'}>
      <summary><i></i><b>${esc(stepLabel(step))}</b><span>${has ? `${tokens(step.text.length)} chars` : 'redacted by the CLI'}</span></summary>
      ${has ? `<div class="talk__step-body mono">${esc(step.text)}</div>` : ''}
    </details>`;
  }
  const st = !step.result ? 'is-run' : step.result.error ? 'is-err' : 'is-ok';
  const res = step.result?.text ?? '';
  return `<details class="talk__step is-tool ${st}" data-step="${esc(step.id)}"${open ? ' open' : ''}>
    <summary title="${esc(step.text)}"><i></i><b>${esc(stepLabel(step))}</b><span>${esc(step.text)}</span></summary>
    <div class="talk__step-body mono">${res ? esc(res) : step.result ? '(no output)' : 'running…'}</div>
  </details>`;
}

