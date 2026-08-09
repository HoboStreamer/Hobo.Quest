import type { ContentRegistry } from '@hobo/content'
import { xpToNextLevel } from '@hobo/content'

/**
 * Skill progression domain. XP is the persistent value; levels are derived
 * from it, so the curve can be retuned without migrating saves. Progression
 * consequences (recipe unlocks, interaction gates) live with the systems
 * that consume levels — this class only accounts.
 */

export interface SkillProgress {
  id: string
  level: number
  /** XP accumulated within the current level. */
  xp: number
  /** XP needed to reach the next level (0 at max level). */
  nextXp: number
}

/** Persistence shape: total xp per skill id. */
export type SkillsDto = Record<string, number>

export interface LevelUp {
  skill: string
  level: number
}

export class SkillSet {
  /** Total lifetime XP per skill. */
  private readonly totalXp = new Map<string, number>()

  constructor(private readonly content: ContentRegistry) {}

  static fromDto(dto: SkillsDto, content: ContentRegistry): SkillSet {
    const set = new SkillSet(content)
    for (const [id, xp] of Object.entries(dto)) {
      if (content.skill(id) && typeof xp === 'number' && xp >= 0) {
        set.totalXp.set(id, xp)
      }
    }
    return set
  }

  toDto(): SkillsDto {
    return Object.fromEntries(this.totalXp)
  }

  levelOf(skillId: string): number {
    return this.progressOf(skillId).level
  }

  progressOf(skillId: string): SkillProgress {
    const def = this.content.skill(skillId)
    const maxLevel = def?.maxLevel ?? 50
    let remaining = this.totalXp.get(skillId) ?? 0
    let level = 1
    while (level < maxLevel) {
      const need = xpToNextLevel(level)
      if (remaining < need) break
      remaining -= need
      level++
    }
    return {
      id: skillId,
      level,
      xp: remaining,
      nextXp: level >= maxLevel ? 0 : xpToNextLevel(level),
    }
  }

  /** Adds XP; returns any level-ups earned (usually 0 or 1). */
  addXp(skillId: string, amount: number): LevelUp[] {
    if (!this.content.skill(skillId) || amount <= 0) return []
    const before = this.levelOf(skillId)
    this.totalXp.set(skillId, (this.totalXp.get(skillId) ?? 0) + Math.floor(amount))
    const after = this.levelOf(skillId)
    const ups: LevelUp[] = []
    for (let level = before + 1; level <= after; level++) {
      ups.push({ skill: skillId, level })
    }
    return ups
  }

  /** Full progress list for replication/UI (only skills defined in content). */
  all(): SkillProgress[] {
    return this.content.allSkills().map((def) => this.progressOf(def.id))
  }
}
