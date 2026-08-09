/** Input button bitfield — mirrors @hobo/protocol Buttons; gameplay stays protocol-free. */
export const Buttons = {
  Jump: 1 << 0,
  Crouch: 1 << 1,
  Sprint: 1 << 2,
  Use: 1 << 3,
  Attack: 1 << 4,
} as const
