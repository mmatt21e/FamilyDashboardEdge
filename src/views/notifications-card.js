/** Per-person notification controls shown in Settings. */

import { el, toast, children } from '../ui.js';
import {
  categories, capability, requestPermission, loadPrefs, savePrefs,
  showActivityNotification, registerDevice,
} from '../notifications.js';

export async function notificationsCard() {
  const { supported, reason, permission } = capability();
  const card = el('section', { class: 'card' },
    el('h2', {}, 'Notifications'),
    el('p', { class: 'muted small' },
      'Choose what you want to hear about. Your own posts and uploads never notify you.'),
  );

  if (!supported) {
    card.append(el('p', { class: 'muted' }, reason));
    return card;
  }

  if (permission !== 'granted') {
    const ask = el('button', { class: 'btn btn--primary' }, 'Turn on notifications');
    ask.addEventListener('click', async () => {
      ask.disabled = true;
      const result = await requestPermission();
      if (result === 'granted') {
        const prefs = await loadPrefs();
        prefs.enabled = true;
        await savePrefs(prefs);
        await registerDevice();
        toast('Notifications are on');
        card.replaceWith(await notificationsCard());
      } else {
        ask.disabled = false;
        toast('Notifications were not allowed', { error: true });
      }
    });

    card.append(...children(
      el('p', { class: 'muted' },
        permission === 'denied'
          ? 'Notifications are blocked for this app. Allow them again in your browser settings for this site.'
          : 'Turn them on to receive family activity alerts on this device.'),
      permission !== 'denied' && ask,
    ));
    return card;
  }

  const prefs = await loadPrefs();
  const categoryInputs = [];
  const master = el('input', {
    type: 'checkbox', class: 'switch__input',
    checked: prefs.enabled ? true : undefined,
    'aria-label': 'All notifications',
  });

  const applyEnabledState = () => {
    for (const input of categoryInputs) input.disabled = !master.checked;
  };

  master.addEventListener('change', async () => {
    prefs.enabled = master.checked;
    applyEnabledState();
    try {
      await savePrefs(prefs);
      if (master.checked) await registerDevice();
      toast(master.checked ? 'Notifications are on' : 'Notifications are off');
    } catch {
      master.checked = !master.checked;
      prefs.enabled = master.checked;
      applyEnabledState();
      toast('Could not save that', { error: true });
    }
  });

  card.append(el('label', { class: 'module-row' },
    el('span', { class: 'module-row__text' },
      el('strong', {}, 'All notifications'),
      el('span', { class: 'muted small' }, 'One switch for this family member on every device.')),
    el('span', { class: 'switch' }, master, el('span', { class: 'switch__track' })),
  ));

  for (const category of categories()) {
    const input = el('input', {
      type: 'checkbox', class: 'switch__input',
      checked: prefs.categories[category.key] ? true : undefined,
      'aria-label': category.title,
    });
    categoryInputs.push(input);

    input.addEventListener('change', async () => {
      prefs.categories[category.key] = input.checked;
      try {
        await savePrefs(prefs);
      } catch {
        input.checked = !input.checked;
        prefs.categories[category.key] = input.checked;
        toast('Could not save that', { error: true });
      }
    });

    card.append(el('label', { class: 'module-row' },
      el('span', { class: 'module-row__text' }, el('span', {}, category.title)),
      el('span', { class: 'switch' }, input, el('span', { class: 'switch__track' })),
    ));
  }
  applyEnabledState();

  const test = el('button', { class: 'btn btn--small', type: 'button' }, 'Send a test notification');
  test.addEventListener('click', async () => {
    const shown = await showActivityNotification({
      category: 'family', title: 'Family Dashboard',
      body: 'Notifications are working on this device.', url: '#/settings',
    });
    toast(shown ? 'Test notification sent' : 'Could not show the test notification', { error: !shown });
  });

  card.append(
    el('div', { class: 'row' }, test),
    el('p', { class: 'muted small' },
      'Alerts arrive while Family Dashboard is open, including in a background tab. Waking a fully closed app requires the Firebase project to add background delivery.'),
  );

  return card;
}
