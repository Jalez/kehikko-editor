import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { Screen, headerItems } from '../src/app.tsx'
import type { Api } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'

afterEach(cleanup)

function host(over: Partial<Host> = {}): Host {
  return {
    where: 'hosted',
    project: 'Thesis',
    projectPath: '/work/thesis',
    epic: 'write-chapter-two',
    focus: [],
    theme: 'dark',
    request: () => Promise.resolve(null),
    header: () => {},
    ...over,
  }
}

const fakeApi = (value: unknown): Api => ({ read: () => Promise.resolve(value), write: () => Promise.resolve() })

describe('the screen', () => {
  test('shows the project, epic and theme the host sent', () => {
    render(<Screen host={host()} api={fakeApi(null)} />)
    expect(screen.getByTestId('project').textContent).toBe('Thesis')
    expect(screen.getByTestId('epic').textContent).toBe('write-chapter-two')
    expect(screen.getByTestId('theme').textContent).toBe('dark')
    expect(screen.getByTestId('where').textContent).toBe('hosted')
  })

  test('says which parts of the epic are picked out, and says so when none are', () => {
    render(<Screen host={host()} api={fakeApi(null)} />)
    expect(screen.getByTestId('parts').textContent).toBe('the whole epic')
    cleanup()
    render(<Screen host={host({ focus: ['The method', 'The results'] })} api={fakeApi(null)} />)
    expect(screen.getByTestId('parts').textContent).toBe('The method, The results')
  })

  test('shows the value stored in the project', async () => {
    render(<Screen host={host()} api={fakeApi('kept')} />)
    await waitFor(() => expect((screen.getByLabelText(/a value kept/) as HTMLInputElement).value).toBe('kept'))
  })

  test('each not-ready state is the shared cover, and none offers to save nowhere', () => {
    const none = { projectPath: null, project: null, epic: null }
    for (const [where, state] of [['listening', 'waiting'], ['unhosted', 'unhosted'], ['hosted', 'no-project']] as const) {
      const { container } = render(<Screen host={host({ ...none, where })} api={fakeApi(null)} />)
      expect(container.querySelector('[data-cover]')?.getAttribute('data-cover')).toBe(state)
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
      cleanup()
    }
  })

  test('alone, the page draws its own header items; hosted, the host does', () => {
    render(<Screen host={host({ where: 'unhosted' })} api={fakeApi(null)} />)
    expect(screen.getByRole('button', { name: /View/ })).toBeDefined()
    cleanup()
    render(<Screen host={host()} api={fakeApi(null)} />)
    expect(screen.queryByRole('button', { name: /View/ })).toBeNull()
  })

  test('the toggle it declares decides whether what the host said is drawn', () => {
    render(<Screen host={host()} api={fakeApi(null)} items={headerItems(false)} />)
    expect(screen.queryByTestId('project')).toBeNull()
  })

  test('the header switcher shows the open item', () => {
    render(<Screen host={host()} api={fakeApi(null)} />)
    expect(screen.getByRole('button', { name: /First/ })).toBeDefined()
  })
})
