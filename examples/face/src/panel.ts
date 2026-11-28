/** The control panel's widgets: labelled sliders in collapsible sections, filtered by a search query. */

export interface Slider { row: HTMLElement; refresh: () => void }

export interface Section { details: HTMLDetailsElement; rows: HTMLElement; count: HTMLElement }

export class Panel {
  private readonly sections: Section[] = []
  private readonly refreshers: (() => void)[] = []

  /** `changed` applies the state after a control changes it; the panel then refreshes. */
  constructor(private readonly element: HTMLElement, private readonly changed: () => void) {}

  /** Applies the state and shows it in every control, after anything changed it. */
  update(): void {
    this.changed()
    for (const refresh of this.refreshers) refresh()
  }

  /** Runs `refresh` on every update. */
  onUpdate(refresh: () => void): void {
    this.refreshers.push(refresh)
  }

  /** A labelled range with a typed value; double-clicking the range resets it to 0. */
  slider(label: string, title: string, get: () => number, put: (value: number) => void, [min, max, step] = [0, 1, 0.01]): Slider {
    const row = document.createElement('div')
    row.className = 'row'
    row.title = title
    const name = document.createElement('span')
    name.textContent = label
    const bounds = { min: String(min), max: String(max), step: String(step) }
    const range = Object.assign(document.createElement('input'), { type: 'range', ...bounds })
    const number = Object.assign(document.createElement('input'), { type: 'number', ...bounds })
    range.setAttribute('aria-label', title)
    number.setAttribute('aria-label', `${title} value`)
    const change = (value: number) => {
      put(Math.min(max, Math.max(min, value)))
      this.update()
    }
    range.addEventListener('input', () => change(range.valueAsNumber))
    range.addEventListener('dblclick', () => change(0))
    number.addEventListener('change', () => change(Number.isFinite(number.valueAsNumber) ? number.valueAsNumber : 0))
    row.append(name, range, number)
    return {
      row,
      refresh: () => {
        const value = get()
        range.valueAsNumber = value
        if (document.activeElement !== number) number.value = step < 1 ? value.toFixed(2) : String(Math.round(value))
        row.classList.toggle('active', value !== 0)
      },
    }
  }

  /** A collapsible section counting its active controls, with a button that resets them. */
  section(title: string, active: () => number, reset: () => void): Section {
    const details = document.createElement('details')
    details.open = true
    const summary = document.createElement('summary')
    const count = document.createElement('span')
    count.className = 'count'
    const button = Object.assign(document.createElement('button'), { textContent: 'Reset', title: `Reset ${title.toLowerCase()}` })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      reset()
      this.update()
    })
    summary.append(title, count, button)
    const rows = document.createElement('div')
    rows.className = 'rows'
    details.append(summary, rows)
    this.element.append(details)
    const section = { details, rows, count }
    this.sections.push(section)
    this.onUpdate(() => { count.textContent = active() ? String(active()) : '' })
    return section
  }

  /** Shows only the rows whose `data-filter` contains `query`, and only sections with such rows. */
  filter(query: string): void {
    for (const s of this.sections) {
      let shown = 0
      for (const row of s.rows.children) {
        if (!(row instanceof HTMLElement)) continue
        const match = !query || (row.dataset.filter ?? '').includes(query)
        row.hidden = !match
        if (match) shown++
      }
      s.details.hidden = shown === 0
      if (query) s.details.open = true
    }
  }
}
