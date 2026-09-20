/** Shared types for the in-app Documentation tab. */

export type GuideStep = { title: string; body: string }
export type GuideSection = {
  id: string
  title: string
  summary: string
  steps: GuideStep[]
  links?: { to: string; label: string }[]
}

export type GuideCopy = {
  eyebrow: string
  title: string
  subtitle: string
  toc: string
  tip: string
  tipBody: string
  searchPlaceholder: string
  searchEmpty: string
  openLabel: string
  sections: GuideSection[]
}
