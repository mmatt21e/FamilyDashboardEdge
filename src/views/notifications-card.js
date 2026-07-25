/**
 * The notifications section of Settings.
 *
 * Says plainly what this device can and cannot do rather than showing switches
 * that quietly have no effect. Three distinct situations:
 *
 *   - the browser cannot do notifications at all (iPhone outside the home
 *     screen), so explain how to fix that
 *   - it can, but permission has not been granted, so ask
 *   - it can and has, but the family has not set up a sender, so preferences
 *     are saved for later and the card says so
 */

import { el, toast } from '../ui.js';
import {
  categories, capability, requestPermission, deliveryConfigured,
  loadPrefs, savePrefs, registerDevice,
} from '../notifications.js';

export async function notificationsCard() {
  const { supported, reason, permission } = capability();
  const card = el('section', { class: 'card' }, el('h2', {}, 'Notifications'));

  if (!supported) {
    card.append(el('p', { class: 'muted' }, reason));
    return card;
  }

  if (permission !== 'granted') {
    const ask = el('button', { class: 'btn btn--primary' }, 'Turn on notifications');
    ask.addEventListener('click', async () => {
      const result = await requestPermission();
      if (result === 'granted') {
        await registerDevice();
        toast('Notifications are on');
        // Redraw so the preference switches replace this button.
        card.replaceWith(await notificationsCard());
      } else {
        toast('Notifications were not allowed', { error: true });
      }
    });

    card.append(
      el('p', { class: 'muted' },
        permission === 'denied'
          ? 'Notifications are blocked for this app. You can allow them again in your browser settings for this site.'
          : 'Get told when something new is posted.'),
      permission !== 'denied' && ask,
    );
    return card;
  }

  // Granted: show the per-person preferences.
  const prefs = await loadPrefs();

  if (!deliveryConfigured()) {
    card.append(el('p', { class: 'muted small' },
      'Your choices are saved, but nothing can send notifications yet — that needs a sender set up on the family’s Firebase project. See the README.'));
  }

  for (const category of categories()) {
    const input = el('input', {
      type: 'checkbox', class: 'switch__input',
      checked: prefs[category.key] ? true : undefined,
      'aria-label': category.title,
    });

    input.addEventListener('change', async () => {
      prefs[category.key] = input.checked;
      try {
        await savePrefs(prefs);
      } catch {
        input.checked = !input.checked;
        toast('Could not save that', { error: true });
      }
    });

    card.append(el('label', { class: 'module-row' },
      el('span', { class: 'module-row__text' }, el('span', {}, category.title)),
      el('span', { class: 'switch' }, input, el('span', { class: 'switch__track' })),
    ));
  }

  card.append(el('p', { class: 'muted small' },
    'These follow you between your phone and tablet — they are saved to your account, not to this device.'));

  return card;
}
