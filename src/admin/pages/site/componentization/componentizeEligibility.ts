import type { PageNode } from '@core/page-tree'
import type { ActiveDocument } from '@site/store/slices/uiSlice'

export function canComponentizeNode(
  activeDocument: ActiveDocument | null,
  node: PageNode | null | undefined,
): node is PageNode {
  return (
    activeDocument?.kind !== 'visualComponent' &&
    !!node &&
    node.moduleId !== 'base.body' &&
    node.moduleId !== 'base.visual-component-ref'
  )
}

/**
 * The inverse gate — `detachVisualComponentRef` is only ever offered on a
 * `base.visual-component-ref` sitting in a page (same mode restriction as
 * componentize: not while already editing a visual component).
 */
export function canDetachComponentRef(
  activeDocument: ActiveDocument | null,
  node: PageNode | null | undefined,
): node is PageNode {
  return activeDocument?.kind !== 'visualComponent' && !!node && node.moduleId === 'base.visual-component-ref'
}
