import type { SkillDef } from '../schema/skill.js'

export const SKILLS: SkillDef[] = [
  {
    id: 'woodcutting',
    name: 'Woodcutting',
    description: 'Felling trees and working lumber.',
    maxLevel: 50,
  },
  {
    id: 'mining',
    name: 'Mining',
    description: 'Breaking stone and prying ore from the earth.',
    maxLevel: 50,
  },
  {
    id: 'scavenging',
    name: 'Scavenging',
    description: 'Finding value in what others left behind.',
    maxLevel: 50,
  },
  {
    id: 'farming',
    name: 'Farming',
    description: 'Planting, tending and harvesting crops.',
    maxLevel: 50,
  },
  {
    id: 'crafting',
    name: 'Crafting',
    description: 'Turning materials into useful things.',
    maxLevel: 50,
  },
  {
    id: 'construction',
    name: 'Construction',
    description: 'Building structures that stay standing.',
    maxLevel: 50,
  },
]
