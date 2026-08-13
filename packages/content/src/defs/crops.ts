import type { CropDef } from '../schema/crop.js'

/**
 * Crop content: materially different growth profiles, not reskins.
 * Berries regrow; mudroot shrugs off drought; ration wheat feeds the mill;
 * wirevine feeds rope production; ember peppers demand warmth and pay for
 * the trouble.
 */
export const CROPS: CropDef[] = [
  {
    id: 'berry',
    name: 'Berry Bush',
    growSeconds: 240,
    stages: 3,
    waterUse: 0.002,
    temperature: { min: 2, max: 38 },
    yield: [{ item: 'berries', count: 6 }],
    // A picked bush keeps its roots: regrows from 40%.
    regrowFraction: 0.4,
    requiredLevel: 1,
    color: '#5a2a4a',
  },
  {
    id: 'mudroot',
    name: 'Mudroot',
    growSeconds: 360,
    stages: 3,
    // Drought-proof survival staple: slow, unthirsty, filling.
    waterUse: 0,
    temperature: { min: -5, max: 42 },
    yield: [{ item: 'mudroot', count: 3 }],
    requiredLevel: 1,
    color: '#7a5c3a',
  },
  {
    id: 'ration_wheat',
    name: 'Ration Wheat',
    growSeconds: 420,
    stages: 4,
    // Thirsty field crop; the mill turns it into flour, the campfire into
    // bread. The backbone of a food business.
    waterUse: 0.004,
    temperature: { min: 5, max: 36 },
    yield: [{ item: 'wheat_sheaf', count: 4 }],
    requiredLevel: 2,
    color: '#c9b04a',
  },
  {
    id: 'wirevine',
    name: 'Wirevine',
    growSeconds: 300,
    stages: 3,
    waterUse: 0.003,
    temperature: { min: 2, max: 40 },
    // Fiber crop: rope without scavenging scrap.
    yield: [{ item: 'vine_fiber', count: 5 }],
    regrowFraction: 0.3,
    requiredLevel: 2,
    color: '#3a7a4a',
  },
  {
    id: 'ember_pepper',
    name: 'Ember Pepper',
    growSeconds: 600,
    stages: 4,
    waterUse: 0.005,
    // Demands warmth: grows daytimes/near heat, pauses cold nights —
    // greenhouse/heated-farm material. The merchant pays a premium.
    temperature: { min: 16, max: 45 },
    yield: [{ item: 'ember_pepper', count: 3 }],
    requiredLevel: 3,
    color: '#c94a2a',
  },
]
