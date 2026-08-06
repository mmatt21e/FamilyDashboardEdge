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

// Incremented when a release turns planned modules into working features. The
// store uses it once to unlock newly completed features even though older
// settings documents necessarily saved those planned switches as false.
export const MODULE_CATALOG_VERSION = 2;

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
  { key: 'photos',    group: 'daily', title: 'Photos',        icon: '📷', status: 'ready', defaultOn: true, toolbarDefault: true, desc: 'Everyone\'s photos from the shared folder, newest first.' },
  { key: 'videos',    group: 'daily', title: 'Videos',        icon: '🎬', status: 'ready', defaultOn: true, toolbarDefault: true, desc: 'The family\'s videos, in their own library.' },
  { key: 'memories',  group: 'daily', title: 'Memories',      icon: '🕰️', status: 'ready', defaultOn: true, toolbarDefault: true, desc: 'On this day: what you were doing a year, four years, ten years ago.' },
  { key: 'feed',      group: 'daily', title: 'Message board', icon: '💬', status: 'ready', defaultOn: true, toolbarDefault: true, desc: 'Short updates and photos, together in one feed.' },
  { key: 'calendar',  group: 'calendar', title: 'Calendar',   icon: '📅', status: 'ready', defaultOn: true, toolbarDefault: true, desc: 'Visits, travel and when everyone is seeing each other.' },

  // --- additional modules ---------------------------------------------------
  { key: 'comments',    group: 'daily', title: 'Comments',            icon: '🗨️', status: 'ready', defaultOn: true, desc: 'Replies and discussion threads for family posts and photos.' },
  { key: 'voicenotes',  group: 'daily', title: 'Voice & video notes', icon: '🎙️', status: 'ready', defaultOn: true, desc: 'Short recorded messages shared through a private link.' },
  { key: 'checkin',     group: 'daily', title: 'Daily check-in',      icon: '👋', status: 'ready', defaultOn: true, desc: 'A quick "I am good today".' },
  { key: 'gratitude',   group: 'daily', title: 'Highlights',          icon: '✨', status: 'ready', defaultOn: true, desc: 'A weekly good thing from each person.' },

  { key: 'birthdays',    group: 'calendar', title: 'Birthdays',        icon: '🎂', status: 'ready', defaultOn: true, desc: 'Birthdays and anniversaries with reminder plans.' },
  { key: 'countdown',    group: 'calendar', title: 'Countdown',        icon: '⏳', status: 'ready', defaultOn: true, desc: 'Days until the next time everyone is together.' },
  { key: 'visitplanner', group: 'calendar', title: 'Visit planner',    icon: '🧳', status: 'ready', defaultOn: true, desc: 'Who is hosting, who is travelling, and what is booked.' },
  { key: 'availability', group: 'calendar', title: 'Availability',     icon: '🕓', status: 'ready', defaultOn: true, desc: 'Free times for calls, visits, rides, and helping.' },
  { key: 'timezones',    group: 'calendar', title: 'Time zones',       icon: '🌍', status: 'ready', defaultOn: true, desc: 'The current local time for everyone.' },

  { key: 'medical',     group: 'care', title: 'Medical info',    icon: '🩺', status: 'ready', desc: 'Medications, doctors, allergies, insurance.' },
  { key: 'medications', group: 'care', title: 'Medications',     icon: '💊', status: 'ready', desc: 'Current medicines and a record of what was taken.' },
  { key: 'appointments',group: 'care', title: 'Appointments',    icon: '📋', status: 'ready', desc: 'Upcoming appointments, preparation and transport.' },
  { key: 'carelog',     group: 'care', title: 'Care log',        icon: '📝', status: 'ready', desc: 'Shared notes between family members coordinating care.' },
  { key: 'wellness',    group: 'care', title: 'Wellness check',  icon: '❤️', status: 'ready', desc: 'A daily check with visible missing check-ins.' },

  { key: 'vault',     group: 'documents', title: 'Documents',      icon: '🗂️', status: 'ready', defaultOn: true, desc: 'Safe references to wills, policies, and property papers.' },
  { key: 'inventory', group: 'documents', title: 'Home inventory', icon: '🏠', status: 'ready', defaultOn: true, desc: 'Household items, photos, receipts, and insurance details.' },
  { key: 'notes',     group: 'documents', title: 'Shared notes',   icon: '📌', status: 'ready', defaultOn: true, desc: 'Bin day, house instructions, and other practical notes.' },

  { key: 'recipes',   group: 'history', title: 'Recipe box',    icon: '🍲', status: 'ready', defaultOn: true, desc: 'Family recipes with ingredients and instructions.' },
  { key: 'stories',   group: 'history', title: 'Story archive',  icon: '📖', status: 'ready', defaultOn: true, desc: 'Recorded memories and written family history.' },
  { key: 'oldphotos', group: 'history', title: 'Old photos',     icon: '🖼️', status: 'ready', defaultOn: true, desc: 'Scanned photographs with names, dates, and stories.' },
  { key: 'tree',      group: 'history', title: 'Family tree',    icon: '🌳', status: 'ready', defaultOn: true, desc: 'Who is related to whom.' },

  { key: 'grocery',     group: 'household', title: 'Shopping list', icon: '🛒', status: 'ready', defaultOn: true, list: true, desc: 'A shared shopping list.' },
  { key: 'meals',       group: 'household', title: 'Meal planning', icon: '🍽️', status: 'ready', defaultOn: true, desc: 'What everyone is eating this week.' },
  { key: 'chores',      group: 'household', title: 'Chores',        icon: '🧹', status: 'ready', defaultOn: true, desc: 'Who is doing what and whether it is complete.' },
  { key: 'allowance',   group: 'household', title: 'Allowance',     icon: '⭐', status: 'ready', defaultOn: true, desc: 'Points and pocket money earned from responsibilities.' },
  { key: 'maintenance', group: 'household', title: 'Home upkeep',   icon: '🔧', status: 'ready', defaultOn: true, desc: 'Services, repairs, and recurring home maintenance.' },

  { key: 'bucketlist', group: 'fun', title: 'Bucket list', icon: '🎯', status: 'ready', defaultOn: true, list: true, desc: 'Things to do together one day.' },
  { key: 'watchlist',  group: 'fun', title: 'Watchlist',   icon: '🍿', status: 'ready', defaultOn: true, list: true, desc: 'Films and shows to watch.' },
  { key: 'reading',    group: 'fun', title: 'Reading',     icon: '📚', status: 'ready', defaultOn: true, list: true, desc: 'Books being read and passed around.' },
  { key: 'playlists',  group: 'fun', title: 'Playlists',   icon: '🎵', status: 'ready', defaultOn: true, list: true, desc: 'Music links everyone can enjoy.' },
  { key: 'polls',      group: 'fun', title: 'Polls',       icon: '🗳️', status: 'ready', defaultOn: true, desc: 'One-person-one-vote family decisions.' },
  { key: 'wishlists',  group: 'fun', title: 'Wish lists',  icon: '🎁', status: 'ready', defaultOn: true, list: true, desc: 'Gift ideas for each person.' },

  { key: 'records',  group: 'money', title: 'Financial records', icon: '🏦', status: 'ready', desc: 'A safe index of accounts and important paperwork.' },
  { key: 'expenses', group: 'money', title: 'Bills & expenses',  icon: '🧾', status: 'ready', desc: 'Upcoming bills, shared costs and what has been paid.' },
  { key: 'budget',   group: 'money', title: 'Shared budget',     icon: '📊', status: 'ready', desc: 'Monthly plans compared with recorded expenses.' },
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

/** Enables every completed feature for a catalog-unlock release. */
export function unlockReadyModules(saved) {
  const state = resolveState(saved);
  for (const module of readyModules()) state[module.key] = true;
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
