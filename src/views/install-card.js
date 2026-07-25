/**
 * "Add to home screen", in Settings.
 *
 * The install step only appears automatically to somebody arriving on an
 * invitation link. Anyone else who has been using the dashboard in a browser
 * tab needs somewhere to find it, and this is that somewhere. It disappears
 * once the app is running from the home screen, because at that point it would
 * be offering to do something already done.
 */

import { el, toast, children } from '../ui.js';
import { installGuidance, promptToInstall, shouldOfferInstall } from '../install.js';

export function installCard() {
  if (!shouldOfferInstall()) return null;

  const card = el('section', { class: 'card' });

  const draw = () => {
    const guidance = installGuidance();
    if (guidance.mode === 'none') return null;

    const install = el('button', { class: 'btn btn--primary' }, 'Add to home screen');
    install.addEventListener('click', async () => {
      install.disabled = true;
      const outcome = await promptToInstall();
      if (outcome === 'accepted') {
        toast('Added to your home screen');
        card.remove();
        return;
      }
      install.disabled = false;
      draw();
    });

    card.replaceChildren(...children(
      el('h2', {}, guidance.title),
      el('p', { class: 'muted small' },
        guidance.detail ?? 'It opens full screen, off the browser, like a normal app.'),
      guidance.mode === 'prompt' && el('div', { class: 'row' }, install),
      guidance.steps.length > 0 && el('ol', { class: 'install-steps' },
        guidance.steps.map((step) => el('li', {}, step))),
    ));
    return card;
  };

  return draw();
}
