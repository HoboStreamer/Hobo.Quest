import { describe, expect, it } from 'vitest'
import {
  DAY_SECONDS,
  WEATHER_KINDS,
  ambientTemperature,
  createEnvironment,
  precipitation,
  stepEnvironment,
} from './environment.js'

describe('environment', () => {
  it('advances time of day and wraps', () => {
    const env = createEnvironment(0.9)
    stepEnvironment(env, DAY_SECONDS * 0.2, () => 0.5)
    expect(env.timeOfDay).toBeCloseTo(0.1, 5)
  })

  it('rolls weather when a spell expires, into valid kinds only', () => {
    const env = createEnvironment()
    const seen = new Set<string>()
    let x = 0
    const rand = () => {
      // Deterministic pseudo-random walk through the transition table.
      x = (x * 9301 + 49297) % 233280
      return x / 233280
    }
    for (let i = 0; i < 500; i++) {
      stepEnvironment(env, 60, rand)
      seen.add(env.weather)
      expect(WEATHER_KINDS).toContain(env.weather)
    }
    expect(seen.size).toBeGreaterThan(2) // it actually changes
  })

  it('rains only in rain/storm', () => {
    const env = createEnvironment()
    env.weather = 'clear'
    expect(precipitation(env)).toBe(0)
    env.weather = 'rain'
    expect(precipitation(env)).toBeGreaterThan(0)
    env.weather = 'storm'
    expect(precipitation(env)).toBe(1)
  })

  it('nights are colder than afternoons; storms colder than clear', () => {
    const night = createEnvironment(0.1)
    const noon = createEnvironment(0.6)
    expect(ambientTemperature(night)).toBeLessThan(ambientTemperature(noon))
    const clear = createEnvironment(0.6)
    clear.weather = 'clear'
    const storm = createEnvironment(0.6)
    storm.weather = 'storm'
    expect(ambientTemperature(storm)).toBeLessThan(ambientTemperature(clear))
  })
})
