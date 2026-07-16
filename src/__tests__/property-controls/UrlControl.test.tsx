import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UrlControl } from '@site/property-controls/UrlControl'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'

beforeEach(() => {
  useEditorStore.setState({
    site: makeSite({ pages: [] }),
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
})

/**
 * A real controlled parent — `value` round-trips through state exactly like
 * the Properties panel does via the store, so onChange firing (or not
 * firing) has the same visible effect a production re-render would.
 */
function ControlledUrlControl({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <UrlControl
      propKey="href"
      label="Link"
      value={value}
      onChange={(_key, next) => setValue(String(next))}
    />
  )
}

function getUrlInput(): HTMLInputElement {
  return screen.getByPlaceholderText('https://…') as HTMLInputElement
}

describe('UrlControl', () => {
  it('shows every intermediate keystroke while typing a URL, even mid-typing invalid states', () => {
    render(<ControlledUrlControl />)
    const input = getUrlInput()

    // Typing "https://example.com" one character at a time — most of these
    // prefixes are not yet a valid URL (e.g. "h", "https:", "https:/"), so
    // onChange never fires for them. The field must still SHOW what was
    // typed instead of reverting to the last committed (empty) value.
    const target = 'https://example.com'
    let typed = ''
    for (const ch of target) {
      typed += ch
      fireEvent.change(input, { target: { value: typed } })
      expect(input.value).toBe(typed)
    }

    // The final, complete URL is valid and must have been committed.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('commits the value once it becomes a valid URL and clears the error', () => {
    render(<ControlledUrlControl />)
    const input = getUrlInput()

    fireEvent.change(input, { target: { value: 'https:/' } })
    expect(screen.getByRole('alert').textContent).toBe('Invalid URL')

    fireEvent.change(input, { target: { value: 'https://example.com' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(input.value).toBe('https://example.com')
  })

  it('does not revert while backspacing through a committed URL', () => {
    render(<ControlledUrlControl initial="https://example.com" />)
    const input = getUrlInput()
    expect(input.value).toBe('https://example.com')

    // Backspace down to "https:/" — an intermediate state the WHATWG URL
    // parser rejects (special schemes require an authority). The field must
    // keep showing exactly what backspacing produced, not snap back to the
    // original committed URL.
    let text = 'https://example.com'
    while (text.length > 'https:/'.length) {
      text = text.slice(0, -1)
      fireEvent.change(input, { target: { value: text } })
      expect(input.value).toBe(text)
    }
    expect(input.value).toBe('https:/')
    expect(screen.getByRole('alert')).toBeDefined()

    // Keep going all the way to empty — empty is a valid (cleared) value.
    while (text.length > 0) {
      text = text.slice(0, -1)
      fireEvent.change(input, { target: { value: text } })
    }
    expect(input.value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('resyncs the draft when the external value changes for a reason other than its own commit', () => {
    const { rerender } = render(
      <UrlControl propKey="href" label="Link" value="https://one.com" onChange={() => {}} />,
    )
    expect(getUrlInput().value).toBe('https://one.com')

    // Simulate switching the selected node — same component instance
    // (PropertyControlRenderer keys only on propKey), new external value.
    rerender(
      <UrlControl propKey="href" label="Link" value="https://two.com" onChange={() => {}} />,
    )
    expect(getUrlInput().value).toBe('https://two.com')
  })
})
