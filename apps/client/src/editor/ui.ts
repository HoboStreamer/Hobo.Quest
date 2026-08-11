/**
 * Editor UI widgets: drag-scrubbable number inputs (Blender-style) and a
 * thumbnail texture picker that replaces bare <select> dropdowns. Pure DOM
 * — no Babylon dependencies.
 */

const stepDecimals = (step: number): number => {
  const s = String(step)
  const dot = s.indexOf('.')
  return dot < 0 ? 0 : s.length - dot - 1
}

/**
 * Blender/Unity-style numeric input: click-drag left/right scrubs the
 * value (Shift = fine), plain click focuses for typing, and ←/→/↑/↓ step
 * while focused. Dispatches 'input' during scrub and 'change' on release.
 */
export function makeScrubbable(input: HTMLInputElement): void {
  if (input.dataset['scrub']) return
  input.dataset['scrub'] = '1'
  input.classList.add('scrub')
  let startX = 0
  let startVal = 0
  let scrubbing = false
  let armed = false
  input.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || document.activeElement === input) return
    armed = true
    scrubbing = false
    startX = e.clientX
    startVal = Number(input.value) || 0
    input.setPointerCapture(e.pointerId)
  })
  input.addEventListener('pointermove', (e) => {
    if (!armed) return
    const dx = e.clientX - startX
    if (!scrubbing && Math.abs(dx) < 4) return
    if (!scrubbing) {
      scrubbing = true
      document.body.classList.add('scrubbing')
    }
    e.preventDefault()
    const step = Number(input.step) || 1
    const speed = e.shiftKey ? 0.1 : 0.5
    let v = startVal + dx * step * speed
    const dec = stepDecimals(step) + (e.shiftKey ? 1 : 0)
    v = Number(v.toFixed(dec))
    if (input.min !== '' && v < Number(input.min)) v = Number(input.min)
    if (input.max !== '' && v > Number(input.max)) v = Number(input.max)
    input.value = String(v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const finish = (e: PointerEvent): void => {
    if (!armed) return
    armed = false
    if (input.hasPointerCapture(e.pointerId)) input.releasePointerCapture(e.pointerId)
    if (scrubbing) {
      scrubbing = false
      document.body.classList.remove('scrubbing')
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.blur()
    }
  }
  input.addEventListener('pointerup', finish)
  input.addEventListener('pointercancel', finish)
  // Suppress the click-to-focus that follows a scrub drag.
  input.addEventListener('click', (e) => {
    if (document.body.classList.contains('scrubbing')) e.preventDefault()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = (Number(input.step) || 1) * (e.shiftKey ? 10 : 1)
    const dec = stepDecimals(Number(input.step) || 1)
    const v = Number(
      ((Number(input.value) || 0) + (e.key === 'ArrowRight' ? step : -step)).toFixed(dec),
    )
    input.value = String(v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Make every number input under `root` scrubbable (idempotent). */
export function scrubAllNumbers(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach(makeScrubbable)
}

export interface TexOption {
  value: string
  label: string
  /** Thumbnail URL; null renders a flat color swatch. */
  thumb: string | null
}

export interface TexPicker {
  /** Re-read options (after uploads/renames) and sync the button. */
  refresh(): void
  /** Update the button after external `select.value = …` writes. */
  sync(): void
}

/**
 * Thumbnail dropdown bound to a hidden <select>: selecting a tile writes
 * select.value and fires 'change', so existing handlers keep working.
 */
export function createTexPicker(sel: HTMLSelectElement, getOptions: () => TexOption[]): TexPicker {
  sel.style.display = 'none'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'texpick-btn'
  sel.insertAdjacentElement('afterend', btn)
  const pop = document.createElement('div')
  pop.className = 'texpick-pop'
  pop.style.display = 'none'
  document.body.appendChild(pop)

  const thumbEl = (opt: TexOption, size: number): HTMLElement => {
    if (opt.thumb) {
      const img = document.createElement('img')
      img.src = opt.thumb
      img.width = size
      img.height = size
      img.loading = 'lazy'
      return img
    }
    const sw = document.createElement('span')
    sw.className = 'texpick-swatch'
    sw.style.width = sw.style.height = `${size}px`
    return sw
  }
  const syncBtn = (): void => {
    const opt = getOptions().find((o) => o.value === sel.value) ?? getOptions()[0]
    btn.replaceChildren()
    if (opt) {
      btn.append(thumbEl(opt, 18))
      const t = document.createElement('span')
      t.textContent = opt.label
      btn.append(t)
    }
  }
  const openPop = (): void => {
    pop.replaceChildren()
    for (const opt of getOptions()) {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = 'texpick-tile'
      if (opt.value === sel.value) tile.classList.add('active')
      tile.append(thumbEl(opt, 46))
      const lbl = document.createElement('span')
      lbl.textContent = opt.label
      tile.append(lbl)
      tile.title = opt.label
      tile.addEventListener('click', () => {
        sel.value = opt.value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        syncBtn()
        pop.style.display = 'none'
      })
      pop.appendChild(tile)
    }
    const r = btn.getBoundingClientRect()
    pop.style.display = 'grid'
    const popW = 248
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - popW - 8, r.left))}px`
    pop.style.top = `${Math.min(window.innerHeight - 260, r.bottom + 4)}px`
  }
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    if (pop.style.display === 'none') openPop()
    else pop.style.display = 'none'
  })
  document.addEventListener('pointerdown', (e) => {
    if (pop.style.display !== 'none' && !pop.contains(e.target as Node) && e.target !== btn)
      pop.style.display = 'none'
  })
  syncBtn()
  return { refresh: syncBtn, sync: syncBtn }
}

/**
 * Downscale an uploaded image to a web-friendly texture (≤2048px, JPEG).
 * Keeps 4k source files usable without shipping 10MB+ to every player.
 */
export async function downscaleImage(
  file: File,
  maxDim = 2048,
): Promise<{ blob: Blob; ext: 'jpg'; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob((b) => res(b), 'image/jpeg', 0.87),
  )
  if (!blob) throw new Error('encode failed')
  return { blob, ext: 'jpg', width: w, height: h }
}
