export type Lang = 'de' | 'en';

export const nav = {
  de: [
    { href: '/termine', label: 'Was ist los' },
    { href: '/raeume', label: 'Räume' },
    { href: '/mitmachen', label: 'Mitmachen' },
    { href: '/ueber-uns', label: 'Über uns' },
    { href: '/kontakt', label: 'Kontakt' },
  ],
  en: [
    { href: '/en/', label: 'Home' },
    { href: '/en/rooms', label: 'Rooms' },
    { href: '/termine', label: 'Events (German)' },
    { href: '/en/contact', label: 'Contact' },
  ],
};

export const t = {
  de: {
    book: 'Raum buchen',
    bookHref: '/buchen',
    skip: 'Zum Inhalt springen',
    menu: 'Hauptmenü',
    menuButton: 'Menü',
    dark: 'Dunkel',
    light: 'Hell',
    org: 'Treibhaus – Verein für gemeinschaftliches Bauen und Wohnen',
    otherLang: { href: '/en/', label: 'English' },
  },
  en: {
    book: 'Book a room',
    bookHref: '/en/booking',
    skip: 'Skip to content',
    menu: 'Main menu',
    menuButton: 'Menu',
    dark: 'Dark',
    light: 'Light',
    org: 'Treibhaus – association for community building and living',
    otherLang: { href: '/', label: 'Deutsch' },
  },
};

export const MATRIX_ROOM = '#hallo:treibhausdonaufeld.at';
export const MATRIX_URL = 'https://matrix.to/#/%23hallo:treibhausdonaufeld.at';
