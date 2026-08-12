/**
 * Server-authoritative environment: time of day, weather, and the ambient
 * temperature gameplay reads (farming moisture, survival cold, visibility
 * later). Understandable gameplay rules, not meteorology. The client only
 * renders what it is told; render code never becomes authority.
 */

export const WEATHER_KINDS = ['clear', 'cloudy', 'rain', 'storm', 'fog'] as const
export type WeatherKind = (typeof WEATHER_KINDS)[number]

export interface EnvironmentState {
  /** Fraction of the day cycle [0..1). 0.25 = sunrise-ish, 0.5 = noon. */
  timeOfDay: number
  weather: WeatherKind
  /** Seconds until the next weather roll. */
  weatherTimer: number
}

/** Real seconds per full day cycle (20 min, matches the render cycle). */
export const DAY_SECONDS = 1200

/** Where each weather tends to go next (simple, readable transitions). */
const TRANSITIONS: Record<WeatherKind, { to: WeatherKind; weight: number }[]> = {
  clear: [
    { to: 'clear', weight: 5 },
    { to: 'cloudy', weight: 3 },
    { to: 'fog', weight: 1 },
  ],
  cloudy: [
    { to: 'clear', weight: 3 },
    { to: 'cloudy', weight: 3 },
    { to: 'rain', weight: 3 },
    { to: 'fog', weight: 1 },
  ],
  rain: [
    { to: 'cloudy', weight: 4 },
    { to: 'rain', weight: 3 },
    { to: 'storm', weight: 2 },
  ],
  storm: [
    { to: 'rain', weight: 5 },
    { to: 'cloudy', weight: 3 },
  ],
  fog: [
    { to: 'clear', weight: 3 },
    { to: 'cloudy', weight: 3 },
    { to: 'fog', weight: 2 },
  ],
}

/** Weather spell length bounds, seconds. */
const SPELL_MIN = 120
const SPELL_MAX = 360

export function createEnvironment(timeOfDay = 0.34): EnvironmentState {
  return { timeOfDay, weather: 'clear', weatherTimer: SPELL_MIN }
}

/**
 * Advances time and rolls weather when a spell expires. `rand` is injected
 * (0..1) so tests are deterministic.
 */
export function stepEnvironment(env: EnvironmentState, dt: number, rand: () => number): void {
  env.timeOfDay = (env.timeOfDay + dt / DAY_SECONDS) % 1
  env.weatherTimer -= dt
  if (env.weatherTimer > 0) return
  env.weatherTimer = SPELL_MIN + rand() * (SPELL_MAX - SPELL_MIN)
  const options = TRANSITIONS[env.weather]
  const total = options.reduce((sum, o) => sum + o.weight, 0)
  let roll = rand() * total
  for (const option of options) {
    roll -= option.weight
    if (roll <= 0) {
      env.weather = option.to
      return
    }
  }
  env.weather = options[options.length - 1]!.to
}

/** Rain intensity 0..1 (farming moisture, wetness). */
export function precipitation(env: EnvironmentState): number {
  switch (env.weather) {
    case 'rain':
      return 0.6
    case 'storm':
      return 1
    default:
      return 0
  }
}

/**
 * Ambient temperature in °C: a day curve (cold nights, warm afternoons)
 * shifted by weather. Deliberately legible numbers: comfortable by day,
 * genuinely cold at night in bad weather.
 */
export function ambientTemperature(env: EnvironmentState): number {
  // Day curve: minimum ~04:30 (t≈0.19), maximum ~14:30 (t≈0.6).
  const swing = Math.sin((env.timeOfDay - 0.35) * Math.PI * 2)
  const base = 14 + swing * 10 // 4°C night .. 24°C afternoon
  const weatherShift: Record<WeatherKind, number> = {
    clear: 2,
    cloudy: -2,
    rain: -6,
    storm: -9,
    fog: -4,
  }
  return base + weatherShift[env.weather]
}
