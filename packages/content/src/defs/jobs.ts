import type { JobDef } from '../schema/job.js'

/** Starter contracts at the trading post: honest work and pest control. */
export const JOBS: JobDef[] = [
  {
    id: 'lumber_run',
    name: 'Lumber Run',
    description: 'The Goose needs building stock. Bring 24 planks.',
    market: 'goose_post',
    objective: { kind: 'deliver', item: 'wood_plank', count: 24 },
    reward: { coins: 10, reputation: 6, items: [], xp: { skill: 'woodcutting', amount: 40 } },
  },
  {
    id: 'bread_line',
    name: 'Bread Line',
    description: 'Hungry mouths in the plaza. Deliver 4 flatbread.',
    market: 'goose_post',
    objective: { kind: 'deliver', item: 'flatbread', count: 4 },
    reward: { coins: 18, reputation: 8, items: [], xp: { skill: 'farming', amount: 60 } },
  },
  {
    id: 'thin_the_rustjaw',
    name: 'Thin the Rustjaw',
    description: 'The crew out past the forest is getting bold. Put down 2 of their thugs.',
    market: 'goose_post',
    objective: { kind: 'kill', archetype: 'rustjaw_thug', count: 2 },
    reward: {
      coins: 14,
      reputation: 10,
      items: [{ item: 'bandage', count: 2 }],
      xp: { skill: 'scavenging', amount: 50 },
    },
  },
]
