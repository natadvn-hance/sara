import type { SectionId } from '@sara/shared'

/** The screens of the pult (M7 design, sections 4 and 5). */
export type Screen =
  | 'today'
  | 'inbox'
  | 'leads'
  | 'lead'
  | 'clients'
  | 'client'
  | 'meetings'
  | 'meeting'
  | 'mind'
  | 'knowledge'
  | 'lesson'
  | 'training'
  | 'trainingItem'
  | 'exams'
  | 'exam'
  | 'analytics'
  | 'accounts'
  | 'account'
  | 'liveLogin'
  | 'direction'
  | 'onboarding'
  | 'recompute'
  | 'settings'
  | 'switch'
  | 'health'
  | 'journal'
  | 'trace'
  | 'help'
  | 'helpPage'
  | 'setup'
  | 'login'

export type Route = { screen: Screen; params: Record<string, string> }

// The more specific path first: /accounts/x/direction/recompute before /accounts/x/direction.
const TABLE: [RegExp, Screen][] = [
  [/^\/$/, 'today'],
  [/^\/inbox\/?$/, 'inbox'],
  [/^\/leads\/?$/, 'leads'],
  [/^\/leads\/([^/]+)\/?$/, 'lead'],
  [/^\/clients\/?$/, 'clients'],
  [/^\/clients\/([^/]+)\/?$/, 'client'],
  [/^\/meetings\/?$/, 'meetings'],
  [/^\/meetings\/([^/]+)\/?$/, 'meeting'],
  [/^\/mind\/?$/, 'mind'],
  [/^\/mind\/lessons\/([^/]+)\/?$/, 'lesson'],
  [/^\/mind\/([^/]+)\/?$/, 'knowledge'],
  [/^\/training\/?$/, 'training'],
  [/^\/training\/([^/]+)\/?$/, 'trainingItem'],
  [/^\/exams\/?$/, 'exams'],
  [/^\/exams\/([^/]+)\/?$/, 'exam'],
  [/^\/analytics\/?$/, 'analytics'],
  [/^\/accounts\/?$/, 'accounts'],
  [/^\/accounts\/([^/]+)\/login\/?$/, 'liveLogin'],
  [/^\/accounts\/([^/]+)\/direction\/recompute\/?$/, 'recompute'],
  [/^\/accounts\/([^/]+)\/direction\/onboarding\/?$/, 'onboarding'],
  [/^\/accounts\/([^/]+)\/direction\/?$/, 'direction'],
  [/^\/accounts\/([^/]+)\/?$/, 'account'],
  [/^\/settings\/?$/, 'settings'],
  [/^\/settings\/switch\/?$/, 'switch'],
  [/^\/health\/?$/, 'health'],
  [/^\/journal\/?$/, 'journal'],
  [/^\/journal\/trace\/([^/]+)\/?$/, 'trace'],
  [/^\/help\/?$/, 'help'],
  [/^\/help\/([^/]+)\/?$/, 'helpPage'],
  [/^\/setup(\/.*)?$/, 'setup'],
  [/^\/login\/?$/, 'login'],
]

/** FR-UI-2: the screen a path opens and its id, or null for a path the pult does not know. */
export function matchRoute(pathname: string): Route | null {
  for (const [re, screen] of TABLE) {
    const m = re.exec(pathname)
    if (!m) continue
    const id = m[1]
    return { screen, params: id === undefined || screen === 'setup' ? {} : { id: decode(id) } }
  }
  return null
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The four bottom tabs (FR-UI-4); every other screen is reached from «Настройки» → «Разделы». */
export type Tab = 'today' | 'leads' | 'clients' | 'settings'

export function tabOf(screen: Screen): Tab {
  if (screen === 'today') return 'today'
  if (screen === 'leads' || screen === 'lead') return 'leads'
  if (screen === 'clients' || screen === 'client') return 'clients'
  return 'settings'
}

/** A tab's own screen has no back button in the Mini App; anything deeper has one. */
export function isTabRoot(screen: Screen): boolean {
  return screen === 'today' || screen === 'leads' || screen === 'clients' || screen === 'settings'
}

/** The menu section a screen belongs to, for the wide screen's side menu. */
export function sectionOf(screen: Screen): SectionId | null {
  switch (screen) {
    case 'today':
      return 'today'
    case 'inbox':
      return 'inbox'
    case 'leads':
    case 'lead':
      return 'leads'
    case 'clients':
    case 'client':
      return 'clients'
    case 'meetings':
    case 'meeting':
      return 'meetings'
    case 'mind':
    case 'knowledge':
    case 'lesson':
      return 'mind'
    case 'training':
    case 'trainingItem':
      return 'training'
    case 'exams':
    case 'exam':
      return 'exams'
    case 'analytics':
      return 'analytics'
    case 'accounts':
    case 'account':
    case 'liveLogin':
    case 'direction':
    case 'onboarding':
    case 'recompute':
      return 'accounts'
    case 'settings':
    case 'switch':
      return 'settings'
    case 'health':
      return 'health'
    case 'journal':
    case 'trace':
      return 'journal'
    case 'help':
    case 'helpPage':
      return 'help'
    case 'setup':
    case 'login':
      return null
  }
}
