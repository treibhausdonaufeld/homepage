import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    lang: z.enum(['de', 'en']).default('de'),
    translationOf: z.string().optional(),
    hero: z.string().optional(),
    heroAlt: z.string().optional(),
  }),
});

const offers = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/offers' }),
  schema: z.object({
    title: z.string(),
    shortUrl: z.string().optional(),
    kategorie: z.enum(['werkstatt', 'bewegung', 'essen', 'kinder', 'kultur', 'treffen']),
    kurz: z.string(),
    rhythmus: z.string(),
    raum: z.string(),
    kosten: z.string(),
    matrixRaum: z.string().default('#hallo:treibhausdonaufeld.at'),
    ansprechperson: z.string().optional(),
    neuHier: z.boolean().default(true),
    status: z.enum(['aktiv', 'pausiert', 'geplant']).default('aktiv'),
    bild: z.string().optional(),
    bildAlt: z.string().optional(),
    reihenfolge: z.number().default(50),
  }),
});

const rooms = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/rooms' }),
  schema: z.object({
    name: z.string(),
    kurz: z.string(),
    kapazitaet: z.number(),
    nutzung: z.string(),
    ausstattung: z.array(z.string()).default([]),
    barrierefrei: z.enum(['ja', 'nein', 'teilweise', 'offen']).default('offen'),
    barrierefreiText: z.string().optional(),
    kombinierbarMit: z.string().optional(),
    preise: z.object({ privat: z.string(), gemeinnuetzig: z.string(), kommerziell: z.string() }),
    einschulung: z.boolean().default(false),
    bilder: z.array(z.object({ src: z.string().optional(), alt: z.string() })).default([]),
    /** slug im Buchungsdienst (SQLite) */
    bookingId: z.string(),
    reihenfolge: z.number().default(50),
    buchbar: z.boolean().default(true),
  }),
});

const partners = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/partners' }),
  schema: z.object({
    name: z.string(),
    url: z.string().url().optional(),
    logo: z.string().optional(),
    logoAlt: z.string().optional(),
    beschreibung: z.string(),
    aktiv: z.boolean().default(true),
    angebote: z.array(z.string()).default([]),
    rolle: z.enum(['kooperation', 'projekt']).default('kooperation'),
  }),
});

export const collections = { pages, offers, rooms, partners };
