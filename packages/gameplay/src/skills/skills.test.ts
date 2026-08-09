import { describe, expect, it } from 'vitest'
import { createContent, xpToNextLevel } from '@hobo/content'
import { SkillSet } from './skills.js'

const content = createContent()

describe('SkillSet', () => {
  it('starts every skill at level 1', () => {
    const skills = new SkillSet(content)
    expect(skills.levelOf('woodcutting')).toBe(1)
    expect(skills.progressOf('woodcutting')).toEqual({
      id: 'woodcutting',
      level: 1,
      xp: 0,
      nextXp: xpToNextLevel(1),
    })
  })

  it('levels up when xp crosses the threshold and reports each level', () => {
    const skills = new SkillSet(content)
    const need = xpToNextLevel(1)
    expect(skills.addXp('mining', need - 1)).toEqual([])
    expect(skills.levelOf('mining')).toBe(1)
    expect(skills.addXp('mining', 1)).toEqual([{ skill: 'mining', level: 2 }])
    expect(skills.levelOf('mining')).toBe(2)
  })

  it('reports multiple level-ups from one large grant', () => {
    const skills = new SkillSet(content)
    const ups = skills.addXp('crafting', xpToNextLevel(1) + xpToNextLevel(2))
    expect(ups).toEqual([
      { skill: 'crafting', level: 2 },
      { skill: 'crafting', level: 3 },
    ])
  })

  it('ignores unknown skills and non-positive xp', () => {
    const skills = new SkillSet(content)
    expect(skills.addXp('flying', 100)).toEqual([])
    expect(skills.addXp('mining', 0)).toEqual([])
    expect(skills.toDto()).toEqual({})
  })

  it('roundtrips through dto (levels derived from total xp)', () => {
    const skills = new SkillSet(content)
    skills.addXp('woodcutting', 500)
    const restored = SkillSet.fromDto(skills.toDto(), content)
    expect(restored.progressOf('woodcutting')).toEqual(skills.progressOf('woodcutting'))
  })

  it('drops invalid dto entries', () => {
    const restored = SkillSet.fromDto({ bogus: 100, mining: -5, woodcutting: 90 }, content)
    expect(restored.toDto()).toEqual({ woodcutting: 90 })
  })
})
