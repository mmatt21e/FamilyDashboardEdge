/**
 * Module registry.
 *
 * Every feature is a module the family switches on or off in Settings.
 * Foundations are always on and cannot be disabled - they are what the optional
 * modules hang off.
 *
 * `status` is honest about what actually works today:
 *   'ready'   built and usable
 *   'planned' listed so the family can see it is coming, shown greyed out
 *
 * Adding a feature later means adding a row here with status 'ready' and a
 * view; nothing else in the app needs to change.
 */

export const GROUPS = [
  { key: 'foundation', title: 'Foundations' },
  { key: 'daily', title: 'Daily life & connection' },
  { key: 'calendar', title: 'Calendar & coordination' },
  { key: 'care', title: 'Care & peace of mind' },
  { key: 'documents', title: 'Documents & keepsakes' },
  { key: 'history', title: 'Family history' },
  { key: 'household', title: 'Household' },
  { key: 'fun', title: 'Connection & fun' },
  { key: 'money', title: 'Money' },
];

/**
 * `list` marks modules that are just a named list of things. They all share one
 * generic list/item structure rather than each getting its own collection, so
 * adding "shared reading list" is a row here, not a new data model.
 */
export const MODULES = [
  // --- foundations (always on) ---------------------------------------------
  { key: 'members',    group: 'foundation', title: 'Family members',   icon: '👪', always: true, status: 'ready', desc: 'Who is in the family and their sign-in.' },
  { key: 'settings',   group: 'foundation', title: 'Settings',         icon: '⚙️', always: true, status: 'ready', desc: 'Turn features on and off, appearance, setup.' },
  { key: 'files',      group: 'foundation', title: 'Shared storage',   icon: '🗄️', always: true, status: 'ready', desc: 'The shared Google Drive folder everything is kept in.' },
  { key: 'onboarding', group: 'foundation', title: 'Setup checklist',  icon: '✅', always: true, status: 'ready', desc: 'Getting each phone installed and syncing photos.' },

  // --- priority modules -----------------------------------------------------
  { key: 'photos',    group: 'daily', title: 'Photos',        icon: '📷', status: 'ready', defaultOn: true,  desc: 'Everyone\'s photos from the shared folder, newest first.' },
  { key: 'videos',    group: 'daily', title: 'Videos',        icon: '🎬', status: 'ready', defaultOn: true,  desc: 'The family\'s videos, in their own library.' },
  { key: 'memories',  group: 'daily', title: 'Memories',      icon: '🕰️', status: 'ready', defaultOn: true,  desc: 'On this day: what you were doing a year, four years, ten years ago.' },
  { key: 'feed',      group: 'daily', title: 'Message board', icon: '💬', status: 'ready', defaultOn: true,  desc: 'Short updates and photos, together in one feed.' },
  { key: 'calendar',  group: 'calendar', title: 'Calendar',   icon: '📅', status: 'ready', defaultOn: true,  desc: 'Visits, travel and when everyone is seeing each other.' },

  // --- additional modules ---------------------------------------------------
  { key: 'comments',    group: 'daily', title: 'Comments',            icon: '🗨️', status: 'planned', desc: 'Replies on photos and posts.' },
  { key: 'voicenotes',  group: 'daily', title: 'Voice & video notes', icon: '🎙️', status: 'planned', desc: 'Short recorded messages.' },
  { key: 'checkin',     group: 'daily', title: 'Daily check-in',      icon: '👋', status: 'planned', desc: 'A quick "I am good today".' },
  { key: 'gratitude',   group: 'daily', title: 'Highlights',          icon: '✨', status: 'planned', desc: 'A weekly good-thing from each person.' },

  { key: 'birthdays',    group: 'calendar', title: 'Birthdays',        icon: '🎂', status: 'planned', desc: 'Birthdays and anniversaries with reminders.' },
  { key: 'countdown',    group: 'calendar', title: 'Countdown',        icon: '⏳', status: 'planned', desc: 'Days until the next time everyone is together.' },
  { key: 'visitplanner', group: 'calendar', title: 'Visit planner',    icon: '🧳', status: 'planned', desc: 'Who is hosting, who is travelling.' },
  { key: 'availability', group: 'calendar', title: 'Availability',     icon: '🕓', status: 'planned', desc: 'Free times for calls and visits.' },
  { key: 'timezones',    group: 'calendar', title: 'Time zones',       icon: '🌍', status: 'planned', desc: 'What time it is for everyone.' },

  { key: 'medical',     group: 'care', title: 'Medical info',    icon: '🩺', status: 'planned', desc: 'Medications, doctors, allergies, insurance.' },
  { key: 'medications', group: 'care', title: 'Medications',     icon: '💊', status: 'planned', desc: 'Reminders and a record of what was taken.' },
  { key: 'appointments',group: 'care', title: 'Appointments',    icon: '📋', status: 'planned', desc: 'Upcoming appointments and reminders.' },
  { key: 'carelog',     group: 'care', title: 'Care log',        icon: '📝', status: 'planned', desc: 'Shared notes between siblings sharing care.' },
  { key: 'wellness',    group: 'care', title: 'Wellness check',  icon: '❤️', status: 'planned', desc: 'A daily check with an alert if it is missed.' },

  { key: 'vault',     group: 'documents', title: 'Documents',      icon: '🗂️', status: 'planned', desc: 'Wills, policies, property papers.' },
  { key: 'inventory', group: 'documents', title: 'Home inventory', icon: '🏠', status: 'planned', desc: 'Photos of what is in the house, for insurance.' },
  { key: 'notes',     group: 'documents', title: 'Shared notes',   icon: '📌', status: 'planned', desc: 'Wifi password, bin day, house instructions.' },

  { key: 'recipes',   group: 'history', title: 'Recipe box',    icon: '🍲', status: 'planned', desc: 'Family recipes.' },
  { key: 'stories',   group: 'history', title: 'Story archive',  icon: '📖', status: 'planned', desc: 'Recorded memories and family history.' },
  { key: 'oldphotos', group: 'history', title: 'Old photos',     icon: '🖼️', status: 'planned', desc: 'Scanned photographs from before phones.' },
  { key: 'tree',      group: 'history', title: 'Family tree',    icon: '🌳', status: 'planned', desc: 'Who is related to whom.' },

  { key: 'grocery',     group: 'household', title: 'Shopping list', icon: '🛒', status: 'planned', list: true, desc: 'A shared shopping list.' },
  { key: 'meals',       group: 'household', title: 'Meal planning', icon: '🍽️', status: 'planned', desc: 'What everyone is eating this week.' },
  { key: 'chores',      group: 'household', title: 'Chores',        icon: '🧹', status: 'planned', desc: 'Who is doing what.' },
  { key: 'allowance',   group: 'household', title: 'Allowance',     icon: '⭐', status: 'planned', desc: 'Points and pocket money for chores.' },
  { key: 'maintenance', group: 'household', title: 'Home upkeep',   icon: '🔧', status: 'planned', desc: 'Boiler service, gutters, that sort of thing.' },

  { key: 'bucketlist', group: 'fun', title: 'Bucket list', icon: '🎯', status: 'planned', list: true, desc: 'Things to do together one day.' },
  { key: 'watchlist',  group: 'fun', title: 'Watchlist',   icon: '🍿', status: 'planned', list: true, desc: 'Films and shows to watch.' },
  { key: 'reading',    group: 'fun', title: 'Reading',     icon: '📚', status: 'planned', list: true, desc: 'Books being passed around.' },
  { key: 'playlists',  group: 'fun', title: 'Playlists',   icon: '🎵', status: 'planned', list: true, desc: 'Music everyone adds to.' },
  { key: 'polls',      group: 'fun', title: 'Polls',       icon: '🗳️', status: 'planned', desc: 'Settling family decisions.' },
  { key: 'wishlists',  group: 'fun', title: 'Wish lists',  icon: '🎁', status: 'planned', list: true, desc: 'Gift ideas for each person.' },

  { key: 'records',  group: 'money', title: 'Financial records', icon: '🏦', status: 'planned', desc: 'Statements and account paperwork.' },
  { key: 'expenses', group: 'money', title: 'Bills & expenses',  icon: '🧾', status: 'planned', desc: 'What is owed and what is paid.' },
  { key: 'budget',   group: 'money', title: 'Shared budget',     icon: '📊', status: 'planned', desc: 'Group costs for trips and gifts.' },
];

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function getModule(key) {
  return BY_KEY.get(key) ?? null;
}

/** Modules that actually work today, in registry order. */
export function readyModules() {
  return MODULES.filter((m) => m.status === 'ready');
}

/**
 * The enabled/disabled state the app should start with, before anything is
 * loaded from Firestore. Foundations on, priority modules on, rest off.
 */
export function defaultState() {
  const state = {};
  for (const m of MODULES) {
    state[m.key] = Boolean(m.always || m.defaultOn);
  }
  return state;
}

/**
 * Merges saved settings over the defaults.
 *
 * Two rules that matter:
 *  - foundations are forced on however the saved data looks, so a bad write can
 *    never lock the family out of Settings and leave no way back;
 *  - modules that are only 'planned' are forced off, so a toggle saved today
 *    cannot surface a half-built screen after an update.
 */
export function resolveState(saved) {
  const state = defaultState();
  if (saved && typeof saved === 'object') {
    for (const [key, value] of Object.entries(saved)) {
      if (BY_KEY.has(key)) state[key] = Boolean(value);
    }
  }
  for (const m of MODULES) {
    if (m.always) state[m.key] = true;
    if (m.status !== 'ready') state[m.key] = false;
  }
  return state;
}

/** Is this module switched on AND actually built? */
export function isEnabled(state, key) {
  const m = getModule(key);
  if (!m || m.status !== 'ready') return false;
  if (m.always) return true;
  return Boolean(state?.[key]);
}

/** Modules to show in the bottom navigation, in registry order. */
export function navModules(state) {
  return readyModules().filter(
    (m) => m.group !== 'foundation' && isEnabled(state, m.key),
  );
}

export function groupedModules() {
  return GROUPS.map((g) => ({
    ...g,
    modules: MODULES.filter((m) => m.group === g.key),
  })).filter((g) => g.modules.length > 0);
}
