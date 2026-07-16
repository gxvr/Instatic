/**
 * detachVisualComponentRef.test.ts — the inverse of convertNodeToComponent:
 * replace a base.visual-component-ref instance with a plain, editable clone
 * of its resolved content, leaving the underlying VisualComponent (and any
 * other ref to it) untouched.
 *
 * Gates:
 *   DVC-1  — basic detach: VC-body nodes get fresh ids, ref replaced in place
 *   DVC-2  — detach preserves sibling position in the parent's children
 *   DVC-3  — propBindings resolve to the override value when present
 *   DVC-4  — propBindings resolve to the param default when no override
 *   DVC-5  — slot-instance content is re-parented (same ids), not cloned
 *   DVC-6  — an unfilled slot-outlet with no default produces no orphan node
 *   DVC-7  — a slot param's defaultValue (template VCNode[]) is cloned fresh
 *   DVC-8  — node-scoped VC-body classes are duplicated; the VC (and a
 *            second still-live ref to it) is unaffected
 *   DVC-9  — propBindings are stripped from the detached clone
 *   DVC-10 — a nested base.visual-component-ref inside the VC body survives
 *            detach as a live ref, not flattened
 *   DVC-11 — the ref's own classIds transfer onto the sole cloned root
 *   DVC-12 — multiple top-level VC-body children splice in as siblings
 *   DVC-13 — selection updates to the first spliced node
 *   DVC-14 — throws when the node is not a base.visual-component-ref
 *   DVC-15 — throws when called from inside a visual component
 *   DVC-16 — throws when componentId does not resolve
 *   DVC-17 — detach does not remove the VC from site.visualComponents
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { create } from 'mutative'
import type { SiteDocument, PageNode, StyleRule } from '@core/page-tree'
import type { VisualComponent, VCNode, VCParam } from '@core/visualComponents'
import '@modules/base/index'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hasUnsavedChanges: false,
    activeDocument: null,
    activePageId: null,
  })
  return useEditorStore.getState()
}

function setupSite() {
  const s = freshStore()
  s.createSite('DVC Test Site')
  return useEditorStore.getState()
}

function getSite() {
  return useEditorStore.getState().site as SiteDocument & {
    visualComponents: VisualComponent[]
    styleRules: Record<string, StyleRule>
  }
}

function getPage(pageId?: string) {
  const site = getSite()
  const pid = pageId ?? useEditorStore.getState().activePageId!
  return site.pages.find((p) => p.id === pid)!
}

function activatePage(pageId?: string) {
  const pid = pageId ?? useEditorStore.getState().activePageId!
  useEditorStore.setState({
    activeDocument: { kind: 'page', pageId: pid },
  } as Parameters<typeof useEditorStore.setState>[0])
}

function callAction<T>(name: string, ...args: unknown[]): T {
  const s = useEditorStore.getState() as Record<string, unknown>
  return (s[name] as (...a: unknown[]) => T)(...args)
}

function makePageNode(
  id: string,
  moduleId: string,
  children: string[] = [],
  overrides: Partial<PageNode> = {},
): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
    classIds: [],
    ...overrides,
  }
}

function makeVCNode(
  id: string,
  moduleId: string,
  children: string[] = [],
  overrides: Partial<VCNode> = {},
): VCNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
    classIds: [],
    ...overrides,
  }
}

function injectNodesIntoPage(rootContainerId: string, extraNodes: PageNode[]): string {
  const state = useEditorStore.getState()
  const pageId = state.activePageId!
  useEditorStore.setState(
    create(state, (draft) => {
      const page = draft.site!.pages.find((p) => p.id === pageId)!
      const pageRoot = page.nodes[page.rootNodeId]
      if (!pageRoot.children.includes(rootContainerId)) {
        pageRoot.children.push(rootContainerId)
      }
      for (const n of extraNodes) {
        page.nodes[n.id] = n
      }
    }),
  )
  return pageId
}

/** Insert a VisualComponent directly into site.visualComponents. */
function injectVC(vc: VisualComponent): void {
  const state = useEditorStore.getState()
  useEditorStore.setState(
    create(state, (draft) => {
      if (!draft.site!.visualComponents) draft.site!.visualComponents = []
      draft.site!.visualComponents.push(vc)
    }),
  )
}

function makeParam(overrides: Partial<VCParam> = {}): VCParam {
  return {
    id: 'param-1',
    name: 'title',
    type: 'text',
    defaultValue: 'Default',
    ...overrides,
  } as VCParam
}

// ---------------------------------------------------------------------------
// DVC-1 — basic detach
// ---------------------------------------------------------------------------

describe('Gate DVC-1 — basic detach', () => {
  beforeEach(() => { setupSite() })

  it('replaces the ref with a fresh clone of the VC body; VC-body nodes get new ids', () => {
    const vc: VisualComponent = {
      id: 'vc-1',
      name: 'Card',
      tree: {
        rootNodeId: 'vc-body-1',
        nodes: {
          'vc-body-1': makeVCNode('vc-body-1', 'base.body', ['vc-text-1']),
          'vc-text-1': makeVCNode('vc-text-1', 'base.text'),
        },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const refId = 'ref-1'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-1', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    expect(page.nodes[refId]).toBeUndefined()

    const pageRoot = page.nodes[page.rootNodeId]
    const newRootId = pageRoot.children.find((id) => id !== page.rootNodeId)!
    const newRoot = page.nodes[newRootId]
    expect(newRoot.moduleId).toBe('base.text')
    expect(newRootId).not.toBe('vc-body-1')
    expect(newRootId).not.toBe('vc-text-1')

    // The VC definition itself is untouched.
    expect(getSite().visualComponents.find((v) => v.id === 'vc-1')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// DVC-2 — sibling position preserved
// ---------------------------------------------------------------------------

describe('Gate DVC-2 — sibling position preserved', () => {
  beforeEach(() => { setupSite() })

  it('the detached content lands at the exact index the ref occupied', () => {
    const vc: VisualComponent = {
      id: 'vc-2',
      name: 'Badge',
      tree: {
        rootNodeId: 'vc-body-2',
        nodes: { 'vc-body-2': makeVCNode('vc-body-2', 'base.body', ['vc-text-2']), 'vc-text-2': makeVCNode('vc-text-2', 'base.text') },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const before1 = makePageNode('before-1', 'base.text')
    const refId = 'ref-2'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-2', propOverrides: {} },
    })
    const after1 = makePageNode('after-1', 'base.text')

    const state = useEditorStore.getState()
    const pageId = state.activePageId!
    useEditorStore.setState(
      create(state, (draft) => {
        const page = draft.site!.pages.find((p) => p.id === pageId)!
        page.nodes[page.rootNodeId].children.push('before-1', refId, 'after-1')
        page.nodes['before-1'] = before1
        page.nodes[refId] = refNode
        page.nodes['after-1'] = after1
      }),
    )
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    const rootChildren = page.nodes[page.rootNodeId].children
    const idx = rootChildren.indexOf('before-1')
    expect(rootChildren[idx + 2]).toBe('after-1')
    // Exactly one new id sits between before-1 and after-1.
    expect(rootChildren.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// DVC-3 / DVC-4 — propBindings resolution
// ---------------------------------------------------------------------------

describe('Gate DVC-3/4 — propBindings resolve to override or default', () => {
  beforeEach(() => { setupSite() })

  function buildBoundVC(): VisualComponent {
    return {
      id: 'vc-3',
      name: 'Titled',
      tree: {
        rootNodeId: 'vc-body-3',
        nodes: {
          'vc-body-3': makeVCNode('vc-body-3', 'base.body', ['vc-text-3']),
          'vc-text-3': makeVCNode('vc-text-3', 'base.text', [], {
            props: { text: 'fallback' },
            propBindings: { text: { paramId: 'param-title' } },
          }),
        },
      },
      params: [makeParam({ id: 'param-title', name: 'title', defaultValue: 'Default Title' })],
      classIds: [],
      createdAt: Date.now(),
    }
  }

  it('DVC-3: override wins over the param default', () => {
    injectVC(buildBoundVC())
    const refId = 'ref-3'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-3', propOverrides: { 'param-title': 'Overridden Title' } },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    const newTextNode = Object.values(page.nodes).find((n) => n.moduleId === 'base.text')!
    expect(newTextNode.props.text).toBe('Overridden Title')
  })

  it('DVC-4: falls back to the param default with no override', () => {
    injectVC(buildBoundVC())
    const refId = 'ref-4'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-3', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    const newTextNode = Object.values(page.nodes).find((n) => n.moduleId === 'base.text')!
    expect(newTextNode.props.text).toBe('Default Title')
  })
})

// ---------------------------------------------------------------------------
// DVC-5 — slot content re-parented, not cloned
// ---------------------------------------------------------------------------

describe('Gate DVC-5 — slot content is re-parented, not cloned', () => {
  beforeEach(() => { setupSite() })

  it('the slot-instance wrapper is removed but its content keeps its original id', () => {
    const vc: VisualComponent = {
      id: 'vc-5',
      name: 'Wrapper',
      tree: {
        rootNodeId: 'vc-body-5',
        nodes: {
          'vc-body-5': makeVCNode('vc-body-5', 'base.body', ['vc-container-5']),
          'vc-container-5': makeVCNode('vc-container-5', 'base.container', ['vc-outlet-5']),
          'vc-outlet-5': makeVCNode('vc-outlet-5', 'base.slot-outlet', [], { props: { slotName: 'children' } }),
        },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const refId = 'ref-5'
    const slotInstanceId = 'slot-inst-5'
    const slotContentId = 'slot-content-5'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [slotInstanceId], {
      props: { componentId: 'vc-5', propOverrides: {} },
    })
    const slotInstance = makePageNode(slotInstanceId, 'base.slot-instance', [slotContentId], {
      props: { slotName: 'children' },
      locked: true,
    } as Partial<PageNode>)
    const slotContent = makePageNode(slotContentId, 'base.text', [], { props: { text: 'User content' } })

    injectNodesIntoPage(refId, [refNode, slotInstance, slotContent])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    // The slot-instance wrapper is gone.
    expect(page.nodes[slotInstanceId]).toBeUndefined()
    // The user content survives with its ORIGINAL id — not cloned.
    expect(page.nodes[slotContentId]).toBeDefined()
    expect(page.nodes[slotContentId].props.text).toBe('User content')

    // It now sits inside the cloned base.container.
    const clonedContainer = Object.values(page.nodes).find((n) => n.moduleId === 'base.container')!
    expect(clonedContainer.children).toContain(slotContentId)
    expect(clonedContainer.id).not.toBe('vc-container-5')
  })
})

// ---------------------------------------------------------------------------
// DVC-6 — unfilled slot-outlet produces no orphan node
// ---------------------------------------------------------------------------

describe('Gate DVC-6 — unfilled slot-outlet leaves no orphan node', () => {
  beforeEach(() => { setupSite() })

  it('an outlet with no slot content and no default disappears cleanly', () => {
    const vc: VisualComponent = {
      id: 'vc-6',
      name: 'EmptySlot',
      tree: {
        rootNodeId: 'vc-body-6',
        nodes: {
          'vc-body-6': makeVCNode('vc-body-6', 'base.body', ['vc-container-6']),
          'vc-container-6': makeVCNode('vc-container-6', 'base.container', ['vc-outlet-6']),
          'vc-outlet-6': makeVCNode('vc-outlet-6', 'base.slot-outlet', [], { props: { slotName: 'children' } }),
        },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const refId = 'ref-6'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-6', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    expect(Object.values(page.nodes).some((n) => n.moduleId === 'base.slot-outlet')).toBe(false)
    const clonedContainer = Object.values(page.nodes).find((n) => n.moduleId === 'base.container')!
    expect(clonedContainer.children).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// DVC-7 — slot param defaultValue is cloned fresh (template, not a page node)
// ---------------------------------------------------------------------------

describe('Gate DVC-7 — slot param defaultValue is cloned with a fresh id', () => {
  beforeEach(() => { setupSite() })

  it('unfilled slot with a defaultValue clones that template content', () => {
    const defaultChild: VCNode = makeVCNode('default-child-7', 'base.text', [], { props: { text: 'Fallback content' } })
    const vc: VisualComponent = {
      id: 'vc-7',
      name: 'DefaultedSlot',
      tree: {
        rootNodeId: 'vc-body-7',
        nodes: {
          'vc-body-7': makeVCNode('vc-body-7', 'base.body', ['vc-outlet-7']),
          'vc-outlet-7': makeVCNode('vc-outlet-7', 'base.slot-outlet', [], { props: { slotName: 'children' } }),
        },
      },
      params: [{ id: 'slot-param-7', name: 'children', type: 'slot', defaultValue: [defaultChild] } as VCParam],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const refId = 'ref-7'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-7', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    // Template default content must NOT keep its VC-internal id — it's cloned.
    expect(page.nodes['default-child-7']).toBeUndefined()
    const clonedText = Object.values(page.nodes).find((n) => n.moduleId === 'base.text')!
    expect(clonedText.props.text).toBe('Fallback content')
  })
})

// ---------------------------------------------------------------------------
// DVC-8 — node-scoped classes duplicated; VC + other refs unaffected
// ---------------------------------------------------------------------------

describe('Gate DVC-8 — node-scoped classes duplicated; VC survives for other refs', () => {
  beforeEach(() => { setupSite() })

  it('duplicates the VC-body node-scoped class and leaves a second ref fully intact', () => {
    const classId = 'cls-scoped-8'
    const state0 = useEditorStore.getState()
    useEditorStore.setState(
      create(state0, (draft) => {
        draft.site!.styleRules[classId] = {
          id: classId,
          name: '.module-8',
          styles: { color: 'red' },
          contextStyles: {},
          scope: { type: 'node', nodeId: 'vc-text-8', role: 'module-style' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }),
    )

    const vc: VisualComponent = {
      id: 'vc-8',
      name: 'Styled',
      tree: {
        rootNodeId: 'vc-body-8',
        nodes: {
          'vc-body-8': makeVCNode('vc-body-8', 'base.body', ['vc-text-8']),
          'vc-text-8': makeVCNode('vc-text-8', 'base.text', [], { classIds: [classId] }),
        },
      },
      params: [],
      classIds: [classId],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const ref1Id = 'ref-8a'
    const ref2Id = 'ref-8b'
    const ref1 = makePageNode(ref1Id, 'base.visual-component-ref', [], { props: { componentId: 'vc-8', propOverrides: {} } })
    const ref2 = makePageNode(ref2Id, 'base.visual-component-ref', [], { props: { componentId: 'vc-8', propOverrides: {} } })
    injectNodesIntoPage(ref1Id, [ref1])
    // Manually add the second ref as a sibling.
    const s = useEditorStore.getState()
    const pageId = s.activePageId!
    useEditorStore.setState(
      create(s, (draft) => {
        const page = draft.site!.pages.find((p) => p.id === pageId)!
        page.nodes[page.rootNodeId].children.push(ref2Id)
        page.nodes[ref2Id] = ref2
      }),
    )
    activatePage()

    const classCountBefore = Object.keys(getSite().styleRules).length

    callAction<void>('detachVisualComponentRef', ref1Id)

    const site = getSite()
    // A new, duplicated scoped class must exist — original count + 1.
    expect(Object.keys(site.styleRules).length).toBe(classCountBefore + 1)
    // The VC's own class-scoped node is untouched.
    expect(site.styleRules[classId].scope?.nodeId).toBe('vc-text-8')

    const page = getPage()
    const detachedText = Object.values(page.nodes).find((n) => n.moduleId === 'base.text')!
    expect(detachedText.classIds.length).toBeGreaterThan(0)
    expect(detachedText.classIds).not.toContain(classId) // it has its OWN duplicated class

    // The second ref (still live) resolves against the unmodified VC.
    expect(page.nodes[ref2Id]).toBeDefined()
    const vcAfter = site.visualComponents.find((v) => v.id === 'vc-8')!
    expect(vcAfter.tree.nodes['vc-text-8'].classIds).toContain(classId)
  })
})

// ---------------------------------------------------------------------------
// DVC-9 — propBindings stripped from the clone
// ---------------------------------------------------------------------------

describe('Gate DVC-9 — propBindings stripped from the detached clone', () => {
  beforeEach(() => { setupSite() })

  it('the cloned node carries the resolved value but no propBindings map', () => {
    const vc: VisualComponent = {
      id: 'vc-9',
      name: 'Bound',
      tree: {
        rootNodeId: 'vc-body-9',
        nodes: {
          'vc-body-9': makeVCNode('vc-body-9', 'base.body', ['vc-text-9']),
          'vc-text-9': makeVCNode('vc-text-9', 'base.text', [], {
            props: { text: 'fallback' },
            propBindings: { text: { paramId: 'param-9' } },
          }),
        },
      },
      params: [makeParam({ id: 'param-9', name: 'title', defaultValue: 'Resolved' })],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const refId = 'ref-9'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-9', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    const clonedText = Object.values(page.nodes).find((n) => n.moduleId === 'base.text')!
    expect(clonedText.props.text).toBe('Resolved')
    expect(clonedText.propBindings).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// DVC-10 — nested VC ref preserved, not flattened
// ---------------------------------------------------------------------------

describe('Gate DVC-10 — nested visual-component-ref preserved as a live ref', () => {
  beforeEach(() => { setupSite() })

  it('a base.visual-component-ref inside the detached body is cloned, not resolved', () => {
    const innerVc: VisualComponent = {
      id: 'vc-inner-10',
      name: 'Inner',
      tree: {
        rootNodeId: 'inner-body-10',
        nodes: { 'inner-body-10': makeVCNode('inner-body-10', 'base.body', ['inner-text-10']), 'inner-text-10': makeVCNode('inner-text-10', 'base.text') },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(innerVc)

    const outerVc: VisualComponent = {
      id: 'vc-outer-10',
      name: 'Outer',
      tree: {
        rootNodeId: 'outer-body-10',
        nodes: {
          'outer-body-10': makeVCNode('outer-body-10', 'base.body', ['outer-inner-ref-10']),
          'outer-inner-ref-10': makeVCNode('outer-inner-ref-10', 'base.visual-component-ref', [], {
            props: { componentId: 'vc-inner-10', propOverrides: {} },
          }),
        },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(outerVc)

    const refId = 'ref-10'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-outer-10', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    const nestedRef = Object.values(page.nodes).find((n) => n.moduleId === 'base.visual-component-ref')!
    expect(nestedRef).toBeDefined()
    expect(nestedRef.props.componentId).toBe('vc-inner-10')
    // It's a fresh clone, not the VC's own internal node.
    expect(nestedRef.id).not.toBe('outer-inner-ref-10')
    // The inner VC itself is untouched.
    expect(getSite().visualComponents.find((v) => v.id === 'vc-inner-10')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// DVC-11 — ref's own classIds transfer onto the sole cloned root
// ---------------------------------------------------------------------------

describe("Gate DVC-11 — the ref's own classIds transfer onto the sole cloned root", () => {
  beforeEach(() => { setupSite() })

  it('an instance-level class on the ref survives onto the single detached root', () => {
    const vc: VisualComponent = {
      id: 'vc-11',
      name: 'Single',
      tree: {
        rootNodeId: 'vc-body-11',
        nodes: { 'vc-body-11': makeVCNode('vc-body-11', 'base.body', ['vc-text-11']), 'vc-text-11': makeVCNode('vc-text-11', 'base.text') },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const refId = 'ref-11'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-11', propOverrides: {} },
      classIds: ['instance-margin-class'],
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    const newRoot = Object.values(page.nodes).find((n) => n.moduleId === 'base.text')!
    expect(newRoot.classIds).toContain('instance-margin-class')
  })
})

// ---------------------------------------------------------------------------
// DVC-12 — multiple top-level VC-body children splice in as siblings
// ---------------------------------------------------------------------------

describe('Gate DVC-12 — multiple top-level children splice in as siblings', () => {
  beforeEach(() => { setupSite() })

  it('a two-child VC body produces two sibling nodes at the ref position', () => {
    const vc: VisualComponent = {
      id: 'vc-12',
      name: 'Pair',
      tree: {
        rootNodeId: 'vc-body-12',
        nodes: {
          'vc-body-12': makeVCNode('vc-body-12', 'base.body', ['vc-a-12', 'vc-b-12']),
          'vc-a-12': makeVCNode('vc-a-12', 'base.text'),
          'vc-b-12': makeVCNode('vc-b-12', 'base.text'),
        },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const refId = 'ref-12'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-12', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    callAction<void>('detachVisualComponentRef', refId)

    const page = getPage()
    const pageRoot = page.nodes[page.rootNodeId]
    const newIds = pageRoot.children.filter((id) => id !== page.rootNodeId)
    expect(newIds).toHaveLength(2)
    for (const id of newIds) expect(page.nodes[id].moduleId).toBe('base.text')
  })
})

// ---------------------------------------------------------------------------
// DVC-13 — selection updates to the first spliced node
// ---------------------------------------------------------------------------

describe('Gate DVC-13 — selection updates to the first spliced node', () => {
  beforeEach(() => { setupSite() })

  it('selectedNodeId points at the new content after detaching', () => {
    const vc: VisualComponent = {
      id: 'vc-13',
      name: 'Sel',
      tree: {
        rootNodeId: 'vc-body-13',
        nodes: { 'vc-body-13': makeVCNode('vc-body-13', 'base.body', ['vc-text-13']), 'vc-text-13': makeVCNode('vc-text-13', 'base.text') },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const refId = 'ref-13'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-13', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()
    useEditorStore.setState({ selectedNodeId: refId, selectedNodeIds: [refId] } as Parameters<typeof useEditorStore.setState>[0])

    callAction<void>('detachVisualComponentRef', refId)

    const state = useEditorStore.getState()
    expect(state.selectedNodeId).not.toBe(refId)
    expect(state.selectedNodeId).not.toBeNull()
    expect(getPage().nodes[state.selectedNodeId!]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// DVC-14/15/16 — throws
// ---------------------------------------------------------------------------

describe('Gate DVC-14 — throws when node is not a ref', () => {
  beforeEach(() => { setupSite() })

  it('throws on a plain node', () => {
    const textId = 'txt-14'
    injectNodesIntoPage(textId, [makePageNode(textId, 'base.text')])
    activatePage()
    expect(() => callAction<void>('detachVisualComponentRef', textId)).toThrow()
  })
})

describe('Gate DVC-15 — throws when called from inside a visual component', () => {
  beforeEach(() => { setupSite() })

  it('throws when activeDocument is a VC', () => {
    const vcId = callAction<string>('createVisualComponent', 'Existing15')
    useEditorStore.setState({
      activeDocument: { kind: 'visualComponent', vcId },
    } as Parameters<typeof useEditorStore.setState>[0])

    expect(() => callAction<void>('detachVisualComponentRef', 'anything')).toThrow(
      'cannot detach from inside a visual component',
    )
  })
})

describe('Gate DVC-16 — throws when componentId does not resolve', () => {
  beforeEach(() => { setupSite() })

  it('throws for an unknown componentId', () => {
    const refId = 'ref-16'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'does-not-exist', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    expect(() => callAction<void>('detachVisualComponentRef', refId)).toThrow(/unknown component/i)
  })
})

// ---------------------------------------------------------------------------
// DVC-17 — VC survives (detach is not delete)
// ---------------------------------------------------------------------------

describe('Gate DVC-17 — the VisualComponent itself is never removed', () => {
  beforeEach(() => { setupSite() })

  it('site.visualComponents still contains the VC after detach', () => {
    const vc: VisualComponent = {
      id: 'vc-17',
      name: 'Persistent',
      tree: {
        rootNodeId: 'vc-body-17',
        nodes: { 'vc-body-17': makeVCNode('vc-body-17', 'base.body', ['vc-text-17']), 'vc-text-17': makeVCNode('vc-text-17', 'base.text') },
      },
      params: [],
      classIds: [],
      createdAt: Date.now(),
    }
    injectVC(vc)

    const refId = 'ref-17'
    const refNode = makePageNode(refId, 'base.visual-component-ref', [], {
      props: { componentId: 'vc-17', propOverrides: {} },
    })
    injectNodesIntoPage(refId, [refNode])
    activatePage()

    const vcCountBefore = getSite().visualComponents.length
    callAction<void>('detachVisualComponentRef', refId)
    expect(getSite().visualComponents.length).toBe(vcCountBefore)
    expect(getSite().visualComponents.find((v) => v.id === 'vc-17')).toBeDefined()
  })
})
