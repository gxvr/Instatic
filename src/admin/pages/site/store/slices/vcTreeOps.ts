/**
 * vcTreeOps — pure helpers and typed domain errors for the Visual Components
 * data layer. Split out of `visualComponentsSlice.ts` (which owns the store
 * actions) so the page-tree surgery — VC-ref collection, cascade removal,
 * subtree cloning for componentization — lives in one focused module, the
 * same pattern as `vcSlotReconcile.ts`.
 */

import { nanoid } from 'nanoid'
import type { VisualComponent, VCNode } from '@core/visualComponents'
import { instantiateVCAtRef, resolveSlotName, safePropOverrides } from '@core/visualComponents'
import type { BaseNode, PageNode, SiteDocument, StyleRule } from '@core/page-tree'
import { cloneNodeWithRemap, cloneScopedClassesForNodeMap, reindexNodeParents, removeNodeSubtrees } from '@core/page-tree'
import type { ActiveDocument } from './uiSlice'
import type { SiteSliceHelpers } from './site/types'

// ---------------------------------------------------------------------------
// Custom error types (exported so UI + tests can catch by class)
// ---------------------------------------------------------------------------

export class VisualComponentNameError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(`[visualComponentsSlice] ${message}`)
    this.name = 'VisualComponentNameError'
    this.code = code
  }
}

export class VisualComponentParamNameError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(`[visualComponentsSlice] ${message}`)
    this.name = 'VisualComponentParamNameError'
    this.code = code
  }
}

export class VisualComponentRecursionError extends Error {
  constructor(message: string) {
    super(`[visualComponentsSlice] ${message}`)
    this.name = 'VisualComponentRecursionError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect all VC componentIds referenced by base.visual-component-ref nodes
 * in the page's flat-map subtree rooted at rootNodeId.
 */
export function collectVCRefsFromPageSubtree(
  pageNodes: Record<string, PageNode>,
  rootNodeId: string,
): Set<string> {
  const refs = new Set<string>()
  const stack: string[] = [rootNodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = pageNodes[id]
    if (!node) continue
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId = node.props.componentId
      if (typeof componentId === 'string' && componentId.length > 0) {
        refs.add(componentId)
      }
    }
    stack.push(...node.children)
  }
  return refs
}

/**
 * Collect all node IDs in the page flat-map subtree rooted at rootNodeId (DFS).
 */
export function collectSubtreeNodeIds(
  pageNodes: Record<string, PageNode>,
  rootNodeId: string,
): string[] {
  const ids: string[] = []
  const stack: string[] = [rootNodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = pageNodes[id]
    if (!node) continue
    ids.push(id)
    stack.push(...node.children)
  }
  return ids
}

/**
 * Remove all `base.visual-component-ref` nodes referencing `vcId` from the
 * given flat-map node tree, along with their entire subtrees (slot-instances,
 * user content, etc.). Operates inside a Mutative recipe — mutates in place.
 *
 * Used by `deleteVisualComponent` to cascade ref removal across every page and
 * every remaining VC tree in one atomic `mutateSite` call.
 */
export function cascadeRemoveVCRefs(
  nodes: Record<string, BaseNode>,
  vcId: string,
): void {
  // Collect all top-level ref IDs that point at vcId
  const refNodeIds: string[] = []
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (
      node.moduleId === 'base.visual-component-ref' &&
      node.props.componentId === vcId
    ) {
      refNodeIds.push(nodeId)
    }
  }

  // Cascade-remove each ref node and its entire subtree (slot-instances, user
  // content, etc.) — same tree surgery the loader uses for dangling refs.
  removeNodeSubtrees(nodes, refNodeIds)
}

/**
 * Clone a page's flat-map subtree into a flat VCNode map.
 *
 * - Allocates a fresh nanoid() for every cloned node.
 * - Populates idMap (oldId → newId) for each visited node so that
 *   parent `children` string arrays reference the correct new IDs.
 * - For node-scoped classes (scope.type === 'node' && scope.nodeId === oldId):
 *   rewrites scope.nodeId to the new ID in-place (must run inside a Mutative
 *   recipe) and records the classId in hoistedClassIds so the caller can
 *   attach it to the new VC's top-level classIds array.
 * - dynamicBindings is intentionally NOT copied — VCNode has no dynamicBindings.
 *
 * Returns { nodes, rootNodeId } — a flat NodeTree for VisualComponent.tree.
 */
export function clonePageSubtreeToFlatNodes(
  pageNodes: Record<string, PageNode>,
  rootNodeId: string,
  siteClasses: Record<string, StyleRule>,
  idMap: Map<string, string>,
  hoistedClassIds: Set<string>,
): { nodes: Record<string, VCNode>; rootNodeId: string } {
  const nodes: Record<string, VCNode> = {}

  // Step 1: allocate new IDs for every node in the subtree (DFS)
  function allocateIds(nodeId: string): void {
    if (idMap.has(nodeId)) return // already allocated (cycle guard)
    idMap.set(nodeId, nanoid())
    const pageNode = pageNodes[nodeId]
    if (!pageNode) return
    for (const childId of pageNode.children) allocateIds(childId)
  }
  allocateIds(rootNodeId)

  // Step 2: clone each node using the id map
  const visited = new Set<string>()
  function cloneNode(oldNodeId: string): void {
    if (visited.has(oldNodeId)) return
    visited.add(oldNodeId)

    const pageNode = pageNodes[oldNodeId]
    if (!pageNode) {
      throw new Error(`convertNodeToComponent: page node "${oldNodeId}" not found during clone`)
    }

    const newId = idMap.get(oldNodeId)!

    // Process classIds: rewrite node-scoped ones to the new ID and hoist to VC level
    const clonedClassIds: string[] = []
    for (const classId of pageNode.classIds) {
      const cls = siteClasses[classId]
      if (cls && cls.scope?.type === 'node' && cls.scope.nodeId === oldNodeId) {
        // Rewrite scope in-place (Mutative draft mutation)
        cls.scope.nodeId = newId
        hoistedClassIds.add(classId)
      }
      clonedClassIds.push(classId)
    }

    const vcNode: VCNode = {
      id: newId,
      moduleId: pageNode.moduleId,
      props: { ...pageNode.props },
      breakpointOverrides: Object.fromEntries(
        Object.entries(pageNode.breakpointOverrides).map(([k, v]) => [k, { ...v }]),
      ),
      // children[] references the NEW ids of direct children
      children: pageNode.children.map((childId) => idMap.get(childId)!),
      classIds: clonedClassIds,
    }

    // Carry optional fields (dynamicBindings excluded — VCNode has no dynamicBindings field)
    if (pageNode.label !== undefined) vcNode.label = pageNode.label
    if (pageNode.locked !== undefined) vcNode.locked = pageNode.locked
    if (pageNode.hidden !== undefined) vcNode.hidden = pageNode.hidden
    if (pageNode.propBindings !== undefined) {
      vcNode.propBindings = Object.fromEntries(
        Object.entries(pageNode.propBindings).map(([k, v]) => [k, { ...v }]),
      )
    }

    nodes[newId] = vcNode

    // Recurse into children
    for (const childId of pageNode.children) cloneNode(childId)
  }
  cloneNode(rootNodeId)

  return { nodes, rootNodeId: idMap.get(rootNodeId)! }
}

/**
 * The core of `detachVisualComponentRef` — resolves `refNode`'s VC instance
 * exactly as `instantiateVCAtRef` does for rendering, materializes fresh page
 * nodes for the VC-body content it owns, re-parents (rather than clones) any
 * real slot content already living in `pageNodes`, and returns the ids ready
 * to splice in at the ref's position. Mutates `pageNodes` and `siteClasses`
 * in place (operates inside a Mutative recipe, same convention as
 * `clonePageSubtreeToFlatNodes`) — the caller is responsible for the actual
 * splice, deleting the ref + its slot-instance wrappers, and re-indexing.
 */
export function detachVCRefIntoPageNodes(
  pageNodes: Record<string, PageNode>,
  siteClasses: Record<string, StyleRule>,
  vc: VisualComponent,
  refNode: PageNode,
): string[] {
  // 1. Build slotInstancesByName from the ref's own slot-instance children —
  // the exact loop the publisher and canvas already run for this ref.
  const slotInstancesByName: Record<string, string[]> = {}
  for (const childId of refNode.children) {
    const child = pageNodes[childId]
    if (child?.moduleId === 'base.slot-instance') {
      slotInstancesByName[resolveSlotName(child.props)] = child.children
    }
  }
  const propOverrides = safePropOverrides(refNode.props)

  // 2. Resolve the VC exactly as instantiateVCAtRef does for rendering —
  // propBindings baked into concrete props, slot outlets expanded.
  const { nodes: instantiated, rootNodeId: vcRootId } = instantiateVCAtRef(
    vc, propOverrides, slotInstancesByName, pageNodes, refNode.id,
  )

  // 3. An unfilled slot-outlet has no page-tree equivalent — drop its
  // placeholder entry. Any parent that still lists its id as a child drops
  // it automatically below (cloneNodeWithRemap prunes ids absent from idMap).
  for (const [id, n] of Object.entries(instantiated)) {
    if (n.moduleId === 'base.slot-outlet') delete instantiated[id]
  }

  // 4. Partition: ids already present in the page are real, existing slot
  // content — kept by reference (identity-mapped), not cloned. Everything
  // else (VC body nodes, and slot-param default content, which is template
  // data, not real page nodes) needs a fresh id.
  const vcOwnedIds = Object.keys(instantiated).filter((id) => pageNodes[id] === undefined)
  const idMap = new Map<string, string>()
  for (const oldId of vcOwnedIds) idMap.set(oldId, nanoid())
  for (const id of Object.keys(instantiated)) {
    if (!idMap.has(id)) idMap.set(id, id)
  }

  // 5. Duplicate node-scoped classes owned by the VC-body nodes being cloned
  // — the VC (and any other ref to it) must keep its own styling untouched.
  // Existing slot-content nodes keep their ids, so their classes are already
  // correctly scoped and need no action.
  const { added: clonedClasses, classIdRemap } = cloneScopedClassesForNodeMap(
    new Map(vcOwnedIds.map((id) => [id, idMap.get(id)!])),
    siteClasses,
  )
  for (const cls of clonedClasses) siteClasses[cls.id] = cls
  const remapClassId = (cid: string) => classIdRemap.get(cid) ?? cid

  // 6. Materialize fresh page nodes for VC-owned content. The VC's base.body
  // root is unwrapped, not spliced in — every NodeTree roots at base.body by
  // invariant, and this splice point is not a tree root.
  for (const oldId of vcOwnedIds) {
    if (oldId === vcRootId) continue
    const { propBindings: _propBindings, _owningRefId: _ref, _fromSlotContent: _slot, ...rest } =
      instantiated[oldId]!
    const cloned = cloneNodeWithRemap(rest as PageNode, {
      newId: idMap.get(oldId)!,
      idMap,
      classIdRemap: remapClassId,
    })
    pageNodes[cloned.id] = cloned
  }

  // 7. The VC root's resolved children are the new top-level siblings.
  const rootChildren = instantiated[vcRootId]?.children ?? []
  const spliceIds = rootChildren.filter((id) => idMap.has(id)).map((id) => idMap.get(id)!)

  // 7b. The ref's OWN classIds/inlineStyles (an instance-level override, e.g.
  // "add margin to just this button") apply to the VC's rendered root at
  // publish time — carry them onto the sole new root so detaching doesn't
  // silently drop a visible instance override. With multiple top-level
  // children there is no single node to carry them onto, so this only fires
  // in the common single-root case.
  if (spliceIds.length === 1) {
    const soleRoot = pageNodes[spliceIds[0]!]
    if (soleRoot && vcOwnedIds.includes(rootChildren[0]!)) {
      soleRoot.classIds = [...new Set([...soleRoot.classIds, ...refNode.classIds])]
      if (refNode.inlineStyles) {
        soleRoot.inlineStyles = { ...refNode.inlineStyles, ...soleRoot.inlineStyles }
      }
    }
  }

  return spliceIds
}

/**
 * Full `detachVisualComponentRef` action body — validation against the
 * current store snapshot, then the `mutateSiteState` transaction wrapping
 * `detachVCRefIntoPageNodes`. Lives here (not inline in the slice) purely to
 * keep `visualComponentsSlice.ts` under the module-size-budgets ceiling.
 */
export function runDetachVisualComponentRef(
  nodeId: string,
  snapshot: { activeDocument: ActiveDocument | null; activePageId: string | null; site: SiteDocument | null },
  mutateSiteState: SiteSliceHelpers['mutateSiteState'],
): void {
  const { activeDocument, activePageId, site } = snapshot
  if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')

  if (activeDocument?.kind === 'visualComponent') {
    throw new Error('detachVisualComponentRef: cannot detach from inside a visual component')
  }
  const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : activePageId
  if (pageId == null) {
    throw new Error('detachVisualComponentRef: no page is active in the editor')
  }

  const page = (site.pages ?? []).find((p) => p.id === pageId)
  if (!page) {
    throw new Error(`detachVisualComponentRef: page "${pageId}" not found`)
  }

  const refNode = page.nodes[nodeId]
  if (!refNode) {
    throw new Error(`detachVisualComponentRef: node "${nodeId}" not found on page "${pageId}"`)
  }
  if (refNode.moduleId !== 'base.visual-component-ref') {
    throw new Error('detachVisualComponentRef: node is not a base.visual-component-ref')
  }

  const componentId = typeof refNode.props.componentId === 'string' ? refNode.props.componentId : ''
  if (!(site.visualComponents ?? []).some((v) => v.id === componentId)) {
    throw new Error(`detachVisualComponentRef: unknown component "${componentId}"`)
  }

  mutateSiteState((state, site) => {
    const draftPage = (site.pages ?? []).find((p) => p.id === pageId)
    if (!draftPage) return false
    const draftRefNode = draftPage.nodes[nodeId]
    if (!draftRefNode) return false
    const draftVc = (site.visualComponents ?? []).find((v) => v.id === componentId)
    if (!draftVc) return false

    const spliceIds = detachVCRefIntoPageNodes(draftPage.nodes, site.styleRules, draftVc, draftRefNode)

    // Splice into the ref's parent, at the ref's exact position.
    let parentNode: PageNode | undefined
    for (const p of Object.values(draftPage.nodes)) {
      if (p.children.includes(nodeId)) {
        parentNode = p
        break
      }
    }
    if (!parentNode) {
      throw new Error('detachVisualComponentRef: ref has no parent')
    }
    const childIdx = parentNode.children.indexOf(nodeId)
    parentNode.children.splice(childIdx, 1, ...spliceIds)

    // Remove the ref and its slot-instance wrappers (not their content —
    // already re-parented into the spliced tree by detachVCRefIntoPageNodes).
    for (const childId of draftRefNode.children) {
      delete draftPage.nodes[childId]
    }
    delete draftPage.nodes[nodeId]

    reindexNodeParents(draftPage.nodes)

    // Select the result, mirroring convertNodeToComponent's own post-mutation
    // selection update.
    const firstNewId = spliceIds[0] ?? null
    state.selectedNodeId = firstNewId
    state.selectedNodeIds = firstNewId ? [firstNewId] : []

    return true
  })
}

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------
