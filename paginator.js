import { waitForFonts, waitForImages, waitForEvent, withAbort, throwIfAborted } from './resource-wait.js'
import { SectionWindow } from './section-window.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        if (document.hidden) {
            render(lerp(a, b, 1))
            return resolve()
        }
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    if (document.hidden) {
        render(lerp(a, b, 1))
        return resolve()
    }
    requestAnimationFrame(step)
})

// Collapsed ranges and boundaries before an image may have no rectangles.
// Find geometry at their start without changing the saved range.
const uncollapse = range => {
    if (!range?.startContainer) return range
    if (!range.collapsed && range.getClientRects().length) return range
    range = range.cloneRange()
    range.collapse(true)
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1 && node.getClientRects().length) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const style = doc.defaultView.getComputedStyle(node)
            if (style.display === 'none') return FILTER_REJECT
            // Hidden and boxless wrappers can still have visible descendants.
            if (style.visibility !== 'visible') return FILTER_SKIP
            const rect = node.getBoundingClientRect()
            // A zero rectangle can mean an empty box or no box at all.
            if (!rect.width && !rect.height && !node.getClientRects().length)
                return FILTER_SKIP
            const { left, right } = mapRect(rect)
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) {
                // A wrapper's start may precede hidden descendants. Prefer the
                // actual visible content, keeping vector images as a single unit.
                return node.children.length && name !== 'svg' && name !== 'math'
                    ? FILTER_SKIP : FILTER_ACCEPT
            }
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            if (doc.defaultView.getComputedStyle(node.parentElement).visibility !== 'visible')
                return FILTER_REJECT
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const rect = range.getBoundingClientRect()
            if (!rect.width && !rect.height && !range.getClientRects().length)
                return FILTER_REJECT
            const { left, right } = mapRect(rect)
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, acceptNode)
    const from = walker.nextNode() ?? doc.body
    let to = from
    for (let node = walker.nextNode(); node; node = walker.nextNode()) to = node

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target?.startContainer) range = target.cloneRange()
    else if (target?.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    let { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    if (writingMode === 'horizontal-tb') {
        let parent = doc.body
        for (let depth = 0; depth < 16; depth++) {
            const children = []
            const modes = []
            for (const el of parent.children) {
                if (!Array.from(el.getClientRects()).some(rect => rect.width && rect.height)) continue
                children.push(el)
                modes.push(defaultView.getComputedStyle(el).writingMode)
                // Two ordinary blocks already rule out a uniform vertical
                // wrapper. Avoid measuring every paragraph of a large chapter.
                if (children.length > 1 && (!/^vertical-/.test(modes[0])
                    || modes[modes.length - 1] !== modes[0])) break
            }
            const uniformVertical = modes.length && /^vertical-/.test(modes[0])
                && modes.every(mode => mode === modes[0])
            if (!uniformVertical && children.length !== 1) break
            if (Array.from(parent.childNodes).some(node =>
                (node.nodeType === 3 || node.nodeType === 4) && node.textContent.trim())) break
            if (uniformVertical) {
                writingMode = modes[0]
                break
            }
            parent = children[0]
        }
    }
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    return { writingMode, vertical, rtl: direction === 'rtl' }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

const overrideStyles = (el, styles, restore) => {
    for (const [property, value] of Object.entries(styles)) {
        const original = el.style.getPropertyValue(property)
        const priority = el.style.getPropertyPriority(property)
        el.style.setProperty(property, value, 'important')
        const applied = el.style.getPropertyValue(property)
        restore.push(() => {
            if (el.style.getPropertyValue(property) === applied
                && el.style.getPropertyPriority(property) === 'important')
                el.style.setProperty(property, original, priority)
        })
    }
}
const restoreStyles = restore => {
    for (const undo of restore.splice(0)) undo()
}

const hasActiveTextSelection = doc => {
    const selection = doc?.getSelection?.()
    return Boolean(selection?.rangeCount && !selection.isCollapsed)
}

class View {
    #loadController
    #observer = new ResizeObserver(() => this.expand())
    #expandFrame
    #mutations = new MutationObserver(() => {
        if (this.#expandFrame) return
        this.#expandFrame = requestAnimationFrame(() => {
            this.#expandFrame = null
            this.expand()
        })
    })
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    #fragmentedStyles = []
    #imageStyles = []
    #directionStyles = []
    #writingStyles = []
    #loadedDoc = null
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        // Keep layout active while parsing so large chapters can reflow
        // incrementally without showing unfinished content.
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'block',
            visibility: 'hidden',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    get ready() {
        return this.#loadedDoc != null && this.document === this.#loadedDoc
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        this.#loadedDoc = null
        this.#iframe.style.visibility = 'hidden'
        this.#loadController?.abort()
        const controller = this.#loadController = new AbortController()
        const { signal } = controller
        const externalSignal = this.container.loadSignal
        const abort = () => controller.abort()
        if (externalSignal?.aborted) abort()
        else externalSignal?.addEventListener('abort', abort, { once: true })
        try {
            throwIfAborted(signal)
            if (this.container.loadDocument) {
                await withAbort(this.container.loadDocument(this.#iframe, src, signal), signal)
            } else {
                const ready = waitForEvent(this.#iframe, ['load'], signal)
                this.#iframe.src = src
                await ready
            }
            throwIfAborted(signal)
            const doc = this.document
            if (!doc?.body) throw new Error('Section has no document body')
            this.#iframe.setAttribute('aria-label', doc.title || 'Book content')
            await waitForImages(doc, signal)
            const original = getDirection(doc)
            if (original.vertical && doc.defaultView.getComputedStyle(doc.body).writingMode !== original.writingMode) {
                // A uniform chapter wrapper defines the page's writing mode.
                // Apply it before load listeners measure the document as well.
                overrideStyles(doc.documentElement, { 'writing-mode': original.writingMode }, this.#writingStyles)
                overrideStyles(doc.body, { 'writing-mode': original.writingMode }, this.#writingStyles)
            }
            afterLoad?.(doc)
            const { vertical, rtl, writingMode } = getDirection(doc)
            const background = getBackground(doc)
            this.#vertical = vertical
            this.#rtl = rtl
            this.#contentRange.selectNodeContents(doc.body)
            const layout = beforeRender?.({ vertical, rtl, writingMode, background })
            // Background measurement needs a stable layout before counting pages.
            if (this.container.loadDocument) await waitForFonts(doc, signal)
            throwIfAborted(signal)
            this.#loadedDoc = doc
            this.#iframe.style.removeProperty('visibility')
            if (!layout) return
            this.render(layout)
            this.#observer.observe(doc.body)
            // WebKit can miss resize notifications after text changes in a
            // neighbouring iframe. Coalesce content changes into one layout.
            this.#mutations.observe(doc.documentElement, {
                childList: true, characterData: true, subtree: true,
            })
            this.refreshFonts()
        } finally {
            externalSignal?.removeEventListener('abort', abort)
        }
    }
    refreshFonts() {
        const doc = this.document
        const signal = this.#loadController?.signal
        if (!doc?.body || !signal) return
        waitForFonts(doc, signal).then(() => {
            if (!signal.aborted && this.document === doc) {
                restoreStyles(this.#fragmentedStyles)
                this.expand()
            }
        }, () => {})
    }
    render(layout) {
        if (!layout || !this.ready) return
        const doc = this.document
        // An out-of-flow body cannot fragment across columns or size the scroll area.
        const position = doc.defaultView.getComputedStyle(doc.body).position
        if (position === 'absolute' || position === 'fixed')
            setStylesImportant(doc.body, { 'position': 'static' })
        restoreStyles(this.#fragmentedStyles)
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        this.#rtl = layout.rtl
        restoreStyles(this.#directionStyles)
        if (this.#column && !this.#vertical) {
            const direction = this.#rtl ? 'rtl' : 'ltr'
            if (doc.defaultView.getComputedStyle(doc.body).direction !== direction) {
                const children = Array.from(doc.body.children, el =>
                    [el, doc.defaultView.getComputedStyle(el).direction])
                overrideStyles(doc.documentElement, { direction }, this.#directionStyles)
                overrideStyles(doc.body, { direction }, this.#directionStyles)
                // Order the columns by the spine while preserving authored text direction.
                for (const [el, original] of children)
                    if (original !== direction)
                        overrideStyles(el, { direction: original }, this.#directionStyles)
            }
        }
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${gap}px 0` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, margin, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': vertical ? `${margin}px` : `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${margin / 2}px ${gap}px` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        restoreStyles(this.#imageStyles)
        const { width, height, gap, columnWidth } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        const availableWidth = this.#column
            ? vertical ? width - 2 * gap : columnWidth
            : vertical ? Infinity : Math.min(columnWidth, width - 2 * gap)
        const availableHeight = this.#column
            ? vertical ? columnWidth : height
            : vertical ? Math.min(columnWidth, height - 2 * gap) : Infinity
        const clamp = (value, limit) => !Number.isFinite(limit) ? value
            : value === 'none' ? `${Math.max(0, limit)}px`
            : `min(${value}, ${Math.max(0, limit)}px)`
        const sizes = Array.from(doc.body.querySelectorAll('img, svg, video'), el => {
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            return [el, maxHeight, maxWidth]
        })
        for (const [el, maxHeight, maxWidth] of sizes)
            overrideStyles(el, {
                'max-height': clamp(maxHeight, availableHeight),
                'max-width': clamp(maxWidth, availableWidth),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            }, this.#imageStyles)
    }
    #fragmentOverflowingBoxes() {
        const doc = this.document
        const root = doc.documentElement
        const vertical = this.#vertical
        const overflow = vertical ? root.scrollWidth - root.clientWidth
            : root.scrollHeight - root.clientHeight
        if (overflow <= 1) return
        const { width, height, gap } = this.#layout
        const available = vertical ? width - 2 * gap : height
        if (!(available > 0)) return
        const fragmentable = {
            'inline-block': 'block', 'inline-flex': 'flex',
            'inline-grid': 'grid', 'inline-table': 'table',
        }
        // Atomic inline boxes cannot split across columns in some engines.
        // Inspect only overflowing documents and leave small boxes unchanged.
        const changes = []
        for (const el of doc.body.querySelectorAll('*')) {
            const display = fragmentable[doc.defaultView.getComputedStyle(el).display]
            if (display && el.getBoundingClientRect()[vertical ? 'width' : 'height'] > available)
                changes.push([el, display])
        }
        for (const [el, display] of changes)
            overrideStyles(el, { display }, this.#fragmentedStyles)
    }
    expand() {
        if (!this.ready || this.#loadController?.signal.aborted || !this.document?.body) return
        const { documentElement } = this.document
        if (this.#column) {
            this.#fragmentOverflowingBoxes()
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            // Pagination leaves an expanded iframe along the other axis. Set
            // its final viewport before measuring reflowed chapter length.
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin } = this.#layout
            const padding = this.#vertical ? `0 ${margin}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer?.element.remove()
        this.#overlayer = overlayer
        if (overlayer) {
            this.#element.append(overlayer.element)
            this.expand()
        }
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        this.#loadedDoc = null
        this.#loadController?.abort()
        this.#observer.disconnect()
        this.#mutations.disconnect()
        cancelAnimationFrame(this.#expandFrame)
        this.#expandFrame = null
        restoreStyles(this.#fragmentedStyles)
        restoreStyles(this.#imageStyles)
        restoreStyles(this.#directionStyles)
        restoreStyles(this.#writingStyles)
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    #navigationController = new AbortController()
    #navigationRequest = 0
    #window
    #windowTarget
    #windowAnchor
    #windowFrame
    #fillingWindow = false
    #changingWindow = false
    #lastScrollTime = 0
    #layout
    #writingMode = 'horizontal-tb'
    #preloadBlocked = new Set()
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #anchoredScroll
    #pendingScroll = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #penActive = false
    #focusingAnchor = false
    #lastRelocation
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            grid-template-rows:
                minmax(var(--_margin), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin), 1fr);
        }
        #top.vertical {
            --_max-column-count-spread: var(--_max-column-count-portrait);
            --_max-width: var(--_max-block-size);
            --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
        }
        #top.portrait {
            --_max-column-count-spread: var(--_max-column-count-portrait);
        }
        #top.portrait.vertical {
            --_max-column-count-spread: var(--_max-column-count);
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            position: relative;
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
            overflow-anchor: none;
            display: flex;
            flex-direction: column;
        }
        :host([flow="scrolled"]) #top.vertical #container {
            flex-direction: row;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container" part="container" tabindex="-1"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this)
        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => {
            if (this.scrolled && (this.#anchoredScroll == null || Math.abs(this.start - this.#anchoredScroll) > 0.5))
                this.#pendingScroll = true
            this.#lastScrollTime = performance.now()
            this.#updateWindowAnchorScroll()
            this.#scheduleWindow()
            this.dispatchEvent(new Event('scroll'))
        })
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                const moved = this.#pendingScroll
                this.#pendingScroll = false
                this.#anchoredScroll = null
                if (moved) this.#afterScroll('scroll')
                this.#scheduleWindow()
            }
        }, 250))

        const opts = { passive: false }
        const listen = target => {
            target.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            target.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            target.addEventListener('touchend', this.#onTouchEnd.bind(this))
            target.addEventListener('touchcancel', () => {
                this.#touchState = null
                this.#touchScrolled = false
                this.#scheduleWindow()
            })
            target.addEventListener('pointerdown', e => this.#penActive = e.pointerType === 'pen')
            target.addEventListener('pointerup', () => this.#penActive = false)
            target.addEventListener('pointercancel', () => this.#penActive = false)
        }
        listen(this)
        this.addEventListener('load', ({ detail: { doc } }) => listen(doc))

        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) {
                    if (hasActiveTextSelection(doc))
                        for (const { view } of this.#window?.records ?? [])
                            if (view.document !== doc && hasActiveTextSelection(view.document))
                                view.document.getSelection().removeAllRanges()
                    this.#scheduleWindow()
                    return
                }
                const range = this.#lastRelocation?.range
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => this.scrolled || this.#focusingAnchor ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target)))
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#background.style.background = getBackground(this.#view.document)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, oldValue, value) {
        if (oldValue === value) return
        switch (name) {
            case 'flow':
                if (!this.scrolled && this.#window) {
                    for (const record of [...this.#window.records])
                        if (record.index !== this.#index && record.index !== this.#windowTarget)
                            this.#window.remove(record)
                    this.#windowAnchor = null
                    cancelAnimationFrame(this.#windowFrame)
                    this.#windowFrame = null
                }
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                // Host styles can keep the container size unchanged.
                this.render()
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/([{\s;])-epub-/gi, '$1')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #ensureWindow() {
        if (this.#window) return
        this.#window = new SectionWindow({
            sections: this.sections,
            create: index => {
                // Keep the host's measurement iframe stable while counting pages.
                if (this.loadDocument && !this.scrolled
                    && this.#view?.element.parentElement === this.#container) return this.#view
                const view = new View({ container: this, onExpand: () => this.#onExpand(view) })
                // Insert in spine order before loading: moving a loaded iframe
                // between DOM positions can reload it and invalidate its ranges.
                Object.assign(view.element.style, {
                    position: 'absolute', visibility: 'hidden', top: '0', left: '0',
                })
                const next = this.#window.records.find(record => record.index > index)
                this.#container.insertBefore(view.element, next?.view.element ?? null)
                return view
            },
            load: (record, src) => {
                const { index, view } = record
                return view.load(src, doc => {
                    if (doc.head) {
                        const before = doc.createElement('style')
                        const after = doc.createElement('style')
                        doc.head.prepend(before)
                        doc.head.append(after)
                        this.#styleMap.set(doc, [before, after])
                    }
                    this.#applyStyles(doc)
                    record.doc = doc
                    this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                }, direction => {
                    record.writingMode = direction.writingMode
                    if (this.#windowTarget === index) return this.#beforeRender(direction)
                    if (direction.writingMode === this.#writingMode) return this.#layout
                })
            },
            unload: ({ index, doc, view }) => {
                if (doc) this.dispatchEvent(new CustomEvent('unload', { detail: { index, doc } }))
                view.overlayer = null
                view.destroy()
                if (!this.loadDocument || this.scrolled) view.element.remove()
            },
        })
    }
    #mountedRecords() {
        return this.#window?.records.filter(record => record.ready && record.mounted) ?? []
    }
    #recordBounds(record, content = false) {
        const element = content ? record.view.document.defaultView.frameElement : record.view.element
        const rect = element.getBoundingClientRect()
        const container = this.#container.getBoundingClientRect()
        const offset = this.#vertical
            ? this.#reversedScroll ? container.right - rect.right : rect.left - container.left
            : rect.top - container.top
        const size = rect[this.sideProp]
        const start = this.start + offset
        return { start, end: start + size, size }
    }
    #visibleRecords() {
        const start = this.start + this.#margin
        const end = Math.max(start + 1, this.end - this.#margin)
        return this.#mountedRecords().filter(record => {
            const bounds = this.#recordBounds(record, true)
            // An empty chapter must still allow preparation of the next one.
            return Math.max(bounds.end, bounds.start + 1) > start + 0.5 && bounds.start < end - 0.5
        })
    }
    #anchorPoint(range) {
        const doc = range.startContainer.ownerDocument
        const frame = doc.defaultView?.frameElement
        const rect = uncollapse(range)?.getBoundingClientRect()
        if (!frame || !rect) return
        const iframe = frame.getBoundingClientRect()
        const container = this.#container.getBoundingClientRect()
        return this.#vertical
            ? this.#reversedScroll ? container.right - iframe.left - rect.right
                : iframe.left + rect.left - container.left
            : iframe.top + rect.top - container.top
    }
    #captureWindowAnchor(range) {
        const anchor = range.cloneRange()
        anchor.collapse(true)
        const offset = this.#anchorPoint(anchor)
        if (Number.isFinite(offset)) this.#windowAnchor = { range: anchor, offset, scroll: this.start }
    }
    #updateWindowAnchorScroll() {
        const anchor = this.#windowAnchor
        if (!anchor) return
        anchor.offset -= this.start - anchor.scroll
        anchor.scroll = this.start
    }
    #restoreWindowAnchor() {
        const anchor = this.#windowAnchor
        if (!anchor || this.#changingWindow || !anchor.range.startContainer.isConnected) return
        const offset = this.#anchorPoint(anchor.range)
        if (!Number.isFinite(offset)) return
        const correction = offset - anchor.offset
        if (Math.abs(correction) > 0.5) {
            this.#container[this.scrollProp] += (this.#reversedScroll ? -1 : 1) * correction
            this.#anchoredScroll = this.start
        }
        anchor.scroll = this.start
        anchor.offset = this.#anchorPoint(anchor.range)
    }
    #onExpand(view) {
        if (this.#navigationController.signal.aborted || this.#changingWindow) return
        if (this.scrolled) {
            this.#restoreWindowAnchor()
            if (this.#windowTarget == null && (view === this.#view
                || this.#visibleRecords().some(record => record.view === view)))
                this.#afterScroll('anchor')
            this.#scheduleWindow()
        } else if (view === this.#view) this.#scrollToAnchor(this.#anchor)
    }
    #mountRecord(record) {
        const wasPinned = record.pinned
        record.pinned = false
        record.mounted = true
        // The overlay's absolute coordinates are local to this document.
        record.view.element.style.position = 'relative'
        for (const property of ['visibility', 'top', 'left'])
            record.view.element.style.removeProperty(property)
        if (wasPinned) record.view.render(this.#layout)
        if (!record.view.overlayer) this.dispatchEvent(new CustomEvent('create-overlayer', { detail: {
            doc: record.view.document, index: record.index,
            attach: overlayer => record.view.overlayer = overlayer,
        } }))
    }
    #scheduleWindow() {
        if (!this.#window || !this.scrolled || this.#windowFrame
            || this.#navigationController.signal.aborted) return
        this.#windowFrame = requestAnimationFrame(() => {
            this.#windowFrame = null
            this.#fillWindow()
        })
    }
    async #fillWindow() {
        const window = this.#window
        if (!window || !this.scrolled || this.#fillingWindow || this.#windowTarget != null) return
        const visible = this.#visibleRecords()
        if (!visible.length) return
        this.#fillingWindow = true
        const request = this.#navigationRequest
        let changed = false
        try {
            for (const record of [...window.records])
                if (record.pinned && !hasActiveTextSelection(record.view.document)) window.remove(record)
            const records = this.#mountedRecords()
            const firstVisible = records.indexOf(visible[0])
            const lastVisible = records.indexOf(visible[visible.length - 1])
            // Keep visible chapters and one neighbour on each side; trim after
            // the touch gesture and momentum scrolling have settled.
            if (!this.#touchState && performance.now() - this.#lastScrollTime > 120) {
                const obsolete = records.filter((_, i) => i < firstVisible - 1 || i > lastVisible + 1)
                if (obsolete.length) {
                    // Relocation is debounced; capture the current passage
                    // before removing the old anchor's document.
                    const range = this.#getVisibleRange()
                    this.#anchor = range
                    this.#captureWindowAnchor(range)
                }
                for (const record of obsolete) {
                    if (hasActiveTextSelection(record.view.document)) {
                        // Preserve the selection outside the scroll flow so it
                        // cannot bridge a gap of unloaded chapters.
                        record.pinned = true
                        record.mounted = false
                        Object.assign(record.view.element.style, {
                            position: 'fixed', visibility: 'hidden', top: '0', left: '0',
                        })
                    } else window.remove(record)
                    changed = true
                }
                this.#restoreWindowAnchor()
            }
            const mounted = this.#mountedRecords()
            const first = mounted[0], last = mounted[mounted.length - 1]
            const candidates = []
            if (last === visible[visible.length - 1]
                && this.#recordBounds(last).end - this.end < this.size * 1.5)
                candidates.push(this.#adjacentIndex(1, last.index))
            if (first === visible[0]
                && this.start - this.#recordBounds(first).start < this.size * 1.5)
                candidates.push(this.#adjacentIndex(-1, first.index))
            const index = candidates.find(index => index != null
                && (!window.get(index) || window.get(index).pinned)
                && !this.#preloadBlocked.has(index))
            if (index == null) return
            try {
                const record = await window.load(index)
                if (window !== this.#window || request !== this.#navigationRequest) {
                    if (this.#windowTarget !== index && this.#index !== index) window.remove(record)
                    return
                }
                if (record.writingMode !== this.#writingMode) {
                    this.#preloadBlocked.add(index)
                    window.remove(record)
                    return
                }
                this.#mountRecord(record)
                this.#restoreWindowAnchor()
                if (this.#visibleRecords().includes(record))
                    this.#afterScroll('anchor')
                changed = true
            } catch (error) {
                if (error.name !== 'AbortError') {
                    this.#preloadBlocked.add(index)
                    console.warn(error)
                }
            }
        } finally {
            this.#fillingWindow = false
            // Prepare at most one neighbour per frame, even for tiny chapters.
            if (changed) this.#scheduleWindow()
        }
    }
    async #goTo(target) {
        const request = ++this.#navigationRequest
        const signal = this.#navigationController.signal
        this.#windowTarget = null
        try {
            const { index, anchor, select } = await withAbort(target, signal)
            throwIfAborted(signal)
            if (request !== this.#navigationRequest || !this.#canGoToIndex(index)) return
            this.#ensureWindow()
            const window = this.#window
            this.#windowTarget = index
            this.#preloadBlocked.clear()
            for (const record of [...window.records])
                if (!record.ready && record.index !== index) window.remove(record)
            if (this.loadDocument && !this.scrolled && index !== this.#index) window.clear()
            const record = await window.load(index)
            if (request !== this.#navigationRequest || window !== this.#window) {
                if (!record.mounted && !record.pinned && this.#windowTarget !== index)
                    window.remove(record)
                return
            }
            const hasFocus = this.#view?.document?.hasFocus()
            this.#windowAnchor = null
            this.#lastRelocation = null
            this.#changingWindow = true
            try {
                if (!this.scrolled || !record.mounted) window.clear(record)
                this.#view = record.view
                this.#index = index
                this.#mountRecord(record)
                record.view.render(this.#beforeRender({
                    ...getDirection(record.view.document),
                    background: getBackground(record.view.document),
                }))
            } finally { this.#changingWindow = false }
            if (hasFocus) this.focusView()
            await this.scrollToAnchor((typeof anchor === 'function'
                ? anchor(record.view.document) : anchor) ?? 0, select)
        } catch (error) {
            if (request === this.#navigationRequest || signal.aborted) throw error
        } finally {
            if (request === this.#navigationRequest) {
                this.#windowTarget = null
                this.#scheduleWindow()
            }
        }
    }
    #beforeRender({ vertical, rtl, writingMode = this.#writingMode, background }) {
        this.#vertical = vertical
        this.#writingMode = writingMode
        this.#rtl = !vertical && (this.bookDir === 'rtl'
            || this.bookDir !== 'ltr' && rtl)
        this.#top.classList.toggle('vertical', vertical)
        const host = this.getBoundingClientRect()
        this.#top.classList.toggle('portrait', host.height >= host.width)

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        if (background !== undefined) this.#background.style.background = background

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            this.setAttribute('dir', this.#reversedScroll ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return this.#layout = { width, height, flow, margin, gap, columnWidth, rtl: this.#rtl }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = (size / divisor) - (vertical ? margin : gap)
        this.setAttribute('dir', this.#rtl ? 'rtl' : 'ltr')

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth, rtl: this.#rtl }
    }
    render() {
        if (!this.#view?.ready) return
        if (this.scrolled) {
            this.#changingWindow = true
            try {
                const layout = this.#beforeRender({ vertical: this.#vertical, rtl: this.#rtl })
                for (const record of this.#window.records)
                    if (record.ready) record.view.render(layout)
            } finally { this.#changingWindow = false }
            if (this.#windowAnchor) {
                this.#restoreWindowAnchor()
                this.#afterScroll('anchor')
            } else this.#scrollToAnchor(this.#anchor)
            this.#scheduleWindow()
            return
        }
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#scrollToAnchor(this.#anchor)
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get index() { return this.#index }
    get #reversedScroll() { return this.#vertical && this.#writingMode === 'vertical-rl' }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get #scrollSize() {
        if (this.scrolled)
            return this.#container[this.#vertical ? 'scrollWidth' : 'scrollHeight']
        return this.viewSize
    }
    get start() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    scrollBy(dx, dy) {
        if (!this.#view?.ready || !this.#scrollBounds) return
        const delta = this.#vertical ? dy : dx
        const element = this.#container
        const { scrollProp } = this
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        element[scrollProp] = Math.max(min, Math.min(max,
            element[scrollProp] + delta))
    }
    async snap(vx, vy) {
        if (!this.#view?.ready || !this.#scrollBounds) return
        const view = this.#view
        const index = this.#index
        const anchor = this.#anchor
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        try {
            await this.#scrollToPage(page, 'snap')
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) await this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        } catch (error) {
            if (view && this.#view === view && this.#index === index
                && !this.#navigationController.signal.aborted)
                await this.#scrollToAnchor(anchor)
            throw error
        }
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, vy: 0,
            stylus: touch?.touchType === 'stylus' || this.#penActive,
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (!state || state.stylus || state.pinched || !this.#view?.ready) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        const doc = e.currentTarget?.getSelection ? e.currentTarget : this.#view?.document
        if (hasActiveTextSelection(doc)) state.selecting = true
        if (state.selecting) return
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
        e.preventDefault()
        const dt = Math.max(1, e.timeStamp - state.t)
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        this.scrollBy(dx, dy)
    }
    #onTouchEnd(e) {
        this.#touchScrolled = false
        if (this.scrolled) {
            this.#touchState = null
            this.#scheduleWindow()
            return
        }
        const doc = e.currentTarget?.getSelection ? e.currentTarget : this.#view?.document
        const state = this.#touchState
        if (!state || state.stylus || state.pinched || state.selecting
            || hasActiveTextSelection(doc)) return

        // Let the viewport scale settle after touchend before snapping.
        requestAnimationFrame(async () => {
            if (state === this.#touchState && globalThis.visualViewport.scale === 1) try {
                await this.snap(state.vx, state.vy)
            } catch (error) {
                console.warn(error)
            }
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const frame = this.#view.document.defaultView.frameElement.getBoundingClientRect()
            const container = this.#container.getBoundingClientRect()
            const start = this.start
            const offset = this.#vertical
                ? this.#reversedScroll ? start + container.right - frame.left
                    : start + frame.left - container.left
                : start + frame.top - container.top
            return this.#vertical
                ? this.#reversedScroll
                    ? ({ left, right }) => ({ left: offset - right, right: offset - left })
                    : ({ left, right }) => ({ left: offset + left, right: offset + right })
                : ({ top, bottom }) => ({ left: offset + top, right: offset + bottom })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const element = this.#container
        const { scrollProp, size } = this
        if (this.scrolled && this.#reversedScroll) offset = -offset
        if (element[scrollProp] === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            element[scrollProp], offset, 300, easeOutQuad,
            x => element[scrollProp] = x,
        ).then(() => {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            element[scrollProp] = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        if (this.scrolled) {
            const doc = (anchor?.startContainer ?? anchor)?.ownerDocument
            const record = this.#window?.records.find(record => record.view.document === doc)
            if (record && record.view !== this.#view)
                return this.goTo({ index: record.index, anchor, select })
        }
        await this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
        if (this.#navigationController.signal.aborted) return
        // The top visible chapter can differ from the navigation target.
        if (select) setSelectionTo(anchor, 0)
        else if (typeof anchor === 'number')
            setSelectionTo(this.#lastRelocation?.range, anchor === 1 ? 1 : -1)
        else setSelectionTo(anchor, -1)
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        this.#anchor = anchor
        if (!(this.size > 0)) return
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            // A hidden target still needs a settled page and usable swipe bounds.
            if (!rect) return this.#scrollToAnchor(0, reason)
            await this.#scrollToRect(rect, reason)
            if (reason === 'navigation' && this.#view?.document.hasFocus()) {
                const node = anchor.startContainer ?? anchor
                const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
                if (el?.focus) {
                    if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) {
                        el.setAttribute('tabindex', '-1')
                        el.addEventListener('blur', () => {
                            if (el.getAttribute('tabindex') === '-1') el.removeAttribute('tabindex')
                        }, { once: true })
                    }
                    this.#focusingAnchor = true
                    try { el.focus({ preventScroll: true }) }
                    finally { this.#focusingAnchor = false }
                }
            }
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            const bounds = this.#recordBounds(this.#window.get(this.#index))
            const offset = Math.min(anchor * bounds.size, Math.max(0, bounds.size - this.size))
            await this.#scrollTo(bounds.start + offset, reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const newPage = Math.round(anchor * Math.max(0, pages - 3))
        await this.#scrollToPage(newPage + 1, reason)
    }
    #getVisibleRange() {
        if (this.scrolled) {
            const record = this.#visibleRecords().find(record => this.#recordBounds(record, true).size > 0)
                ?? this.#window.get(this.#index)
            if (record?.ready && record.mounted && this.#index !== record.index) {
                this.#index = record.index
                this.#view = record.view
                this.#anchor = 0
                this.#background.style.background = getBackground(record.view.document)
            }
            return getVisibleRange(this.#view.document,
                this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        }
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        if (!this.#view?.ready || this.#navigationController.signal.aborted) return
        const range = this.#getVisibleRange()
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else {
            this.#pendingScroll = false
            this.#anchoredScroll = this.start
        }

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) {
            const bounds = this.#recordBounds(this.#window.get(index))
            detail.fraction = bounds.size > 0
                ? Math.max(0, Math.min(1, (this.start - bounds.start) / bounds.size)) : 0
            const visible = this.#visibleRecords()
            const atEnd = this.atEnd
            const last = atEnd ? this.#window.get(this.#edgeIndex(1))
                : visible[visible.length - 1] ?? this.#window.get(index)
            const endBounds = this.#recordBounds(last)
            detail.end = { index: last.index, fraction: atEnd || endBounds.size === 0 ? 1
                : Math.max(0, Math.min(1, (this.end - endBounds.start) / endBounds.size)) }
            this.#captureWindowAnchor(range)
        }
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        const previous = this.#lastRelocation
        const unchanged = reason === 'anchor' && previous
            && index === previous.index && detail.fraction === previous.fraction && detail.size === previous.size
            && detail.end?.index === previous.end?.index && detail.end?.fraction === previous.end?.fraction
            && range.startContainer === previous.range.startContainer && range.startOffset === previous.range.startOffset
            && range.endContainer === previous.range.endContainer && range.endOffset === previous.range.endOffset
        this.#lastRelocation = detail
        // Settling fonts or observers may report the same layout again. Avoid
        // treating that as navigation in consumers such as selection toolbars.
        if (!unchanged) this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async goTo(target) {
        if (!this.#locked) return this.#goTo(target)
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return true
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.#scrollSize - this.end > 2) return this.#scrollTo(
                Math.min(this.#scrollSize, distance ? this.start + distance : this.end), null, true)
            return true
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        if (this.scrolled) return this.#adjacentIndex(-1, this.#edgeIndex(-1)) == null && this.start <= 1
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        if (this.scrolled) return this.#adjacentIndex(1, this.#edgeIndex(1)) == null && this.end >= this.#scrollSize - 2
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir, from = this.#index) {
        for (let index = from + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    #edgeIndex(dir) {
        const records = this.#mountedRecords()
        return records[dir < 0 ? 0 : records.length - 1]?.index ?? this.#index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        const view = this.#view
        const index = this.#index
        const anchor = this.#anchor
        try {
            const prev = dir === -1
            const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
            if (shouldGo) {
                const from = this.scrolled ? this.#edgeIndex(dir) : this.#index
                const target = { index: this.#adjacentIndex(dir, from), anchor: prev ? 1 : 0 }
                await this.#goTo(target)
            }
            if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        } catch (error) {
            if (view && this.#view === view && this.#index === index
                && !this.#navigationController.signal.aborted)
                await this.#scrollToAnchor(anchor)
            throw error
        } finally {
            this.#locked = false
        }
    }
    prev(distance) {
        return this.#turnPage(-1, distance)
    }
    next(distance) {
        return this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        for (let index = this.sections.length - 1; index >= 0; index--)
            if (this.sections[index].linear !== 'no') return this.goTo({ index })
    }
    getContents() {
        return (this.#window?.records ?? [])
            .filter(record => record.ready && (record.mounted || record.pinned))
            .map(({ index, view }) => ({ index, doc: view.document, overlayer: view.overlayer }))
    }
    getCurrentContent() { return this.getContents().find(content => content.index === this.#index) }
    setStyles(styles) {
        this.#styles = styles
        for (const { view } of this.#window?.records ?? []) {
            this.#applyStyles(view.document)
            if (view.ready) view.refreshFonts()
        }

        requestAnimationFrame(() => {
            const doc = this.#view?.document
            if (doc?.body) this.#background.style.background = getBackground(doc)
        })
    }
    #applyStyles(doc) {
        const styles = this.#styles
        const $$styles = this.#styleMap.get(doc)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles
    }
    focusView() {
        // Keep native keyboard scrolling on a stable element as chapters come and go.
        if (this.scrolled) this.#container.focus({ preventScroll: true })
        else this.#view.document.defaultView.focus()
    }
    destroy() {
        if (this.#navigationController.signal.aborted) return
        this.#navigationController.abort()
        this.#navigationRequest++
        cancelAnimationFrame(this.#windowFrame)
        this.#observer.disconnect()
        this.#window?.clear()
        this.#window = null
        this.#windowAnchor = null
        this.#lastRelocation = null
        this.#anchor = 0
        this.#view = null
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
