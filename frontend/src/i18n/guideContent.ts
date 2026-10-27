/** In-app Documentation tab — locale copy lives in guideRu / guideEn. */

export type { GuideCopy, GuideSection, GuideStep } from './guideTypes'
import type { GuideCopy, GuideSection } from './guideTypes'
import { GUIDE_EN } from './guideEn'
import { GUIDE_RU } from './guideRu'

export function guideCopy(locale: 'ru' | 'en'): GuideCopy {
  return locale === 'en' ? GUIDE_EN : GUIDE_RU
}

/** Search used by the in-app Documentation tab. Exported so tests match the UI. */
export function filterGuideSections(sections: GuideSection[], query: string): GuideSection[] {
  const q = query.trim().toLowerCase()
  if (!q) return sections
  return sections
    .map((section) => {
      const titleHit = section.title.toLowerCase().includes(q) || section.summary.toLowerCase().includes(q)
      const steps = section.steps.filter(
        (step) => step.title.toLowerCase().includes(q) || step.body.toLowerCase().includes(q),
      )
      if (titleHit) return section
      if (steps.length === 0) return null
      return { ...section, steps }
    })
    .filter((s): s is GuideSection => s != null)
}
