const parseViewport = str => str
    ?.replace(/\s*=\s*/g, '=')
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const viewportSize = viewport => {
    const width = Number(viewport?.width), height = Number(viewport?.height)
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)
        return { width, height }
}

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.trim().split(/[\s,]+/) ?? []
        const size = viewportSize({ width, height })
        if (size) return size
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    const metaSize = meta && viewportSize(Object.fromEntries(meta))
    if (metaSize) return metaSize

    // fallback to book's viewport
    const bookSize = viewportSize(typeof viewport === 'string'
        ? Object.fromEntries(parseViewport(viewport)) : viewport)
    if (bookSize) return bookSize

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    const imageSize = img && viewportSize({ width: img.naturalWidth, height: img.naturalHeight })
    if (imageSize) return imageSize

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom']
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.#render().catch(console.error))
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    #style = document.createElement('style')
    constructor() {
        super()

        this.#style.textContent = `:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: auto;
        }`
        this.#root.append(this.#style)

        this.#observer.observe(this)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render().catch(console.error)
                break
        }
    }
    async #createFrame({ index, src: srcOption }) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        element.style.position = 'relative'
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        this.#root.append(element)
        if (!src) return { index, blank: true, element, iframe }
        return new Promise(resolve => {
            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument
                iframe.setAttribute('aria-label', doc.title || 'Book content')
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                resolve({
                    index, element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                })
            }, { once: true })
            iframe.src = src
        })
    }
    async #render(side = this.#side) {
        if (!side) return
        this.#side = side
        const left = this.#left ?? {}
        const right = this.#center ?? this.#right ?? {}
        const target = side === 'left' ? left : right
        const { width, height } = this.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && height > width
        this.#portrait = portrait
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        const scale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || this.#center
                    ? width / (target.width ?? blankWidth)
                    : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : (portrait || this.#center
                    ? Math.min(
                        width / (target.width ?? blankWidth),
                        height / (target.height ?? blankHeight))
                    : Math.min(
                        width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                        height / Math.max(
                            left.height ?? blankHeight,
                            right.height ?? blankHeight)))
            ) || 1

        const transform = frame => {
            let { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            const iframeScale = onZoom ? scale : 1
            Object.assign(iframe.style, {
                width: `${width * iframeScale}px`,
                height: `${height * iframeScale}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                overflow: 'hidden',
                display: 'block',
                flexShrink: '0',
                marginBlock: 'auto',
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
                return
            }
            if (blank) return
            frame.scale = scale
            // A zoom callback may rebuild the document asynchronously. Serialize
            // those writes and skip obsolete requests before resolving ranges.
            frame.rendering = (frame.rendering ?? Promise.resolve()).catch(() => {}).then(async () => {
                if (scale !== frame.scale || !this.#root.contains(element)) return
                if (onZoom && frame.renderedScale !== scale) {
                    frame.overlayer?.element.remove()
                    frame.overlayer = null
                    frame.renderedScale = null
                    await onZoom({ doc: iframe.contentDocument, scale })
                    frame.renderedScale = scale
                }
                if (scale !== frame.scale || !this.#root.contains(element)
                    || element.style.display === 'none') return
                if (!frame.overlayer) this.dispatchEvent(new CustomEvent('create-overlayer', {
                    detail: {
                        doc: iframe.contentDocument, index: frame.index,
                        attach: overlayer => {
                            frame.overlayer = overlayer
                            // EPUB ranges use unscaled coordinates. Renderers
                            // with onZoom already supply ranges at display size.
                            if (!onZoom) {
                                overlayer.element.setAttribute('viewBox', `0 0 ${width} ${height}`)
                                overlayer.element.setAttribute('preserveAspectRatio', 'none')
                            }
                            element.append(overlayer.element)
                        },
                    },
                }))
                else frame.overlayer.redraw()
            })
            return frame.rendering
        }
        if (this.#center) {
            await transform(this.#center)
        } else {
            await Promise.all([transform(left), transform(right)])
        }
    }
    async #showSpread({ left, right, center, side }) {
        this.#root.replaceChildren(this.#style)
        this.#left = null
        this.#right = null
        this.#center = null
        if (center) {
            this.#center = await this.#createFrame(center)
            this.#side = 'center'
            await this.#render()
        } else {
            this.#left = await this.#createFrame(left)
            this.#right = await this.#createFrame(right)
            this.#side = this.#left.blank ? 'right'
                : this.#right.blank ? 'left' : side
            await this.#render()
        }
    }
    async #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            await this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    async #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            await this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    open(book) {
        this.book = book
        const { rendition } = book
        this.spread = rendition?.spread
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    get index() {
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            await this.#render(side)
            this.#reportLocation(reason)
            return
        }
        this.#index = index
        const spread = this.#spreads[index]
        if (spread.center) {
            const index = this.book.sections.indexOf(spread.center)
            const src = await spread.center?.load?.()
            await this.#showSpread({ center: { index, src } })
        } else {
            const indexL = this.book.sections.indexOf(spread.left)
            const indexR = this.book.sections.indexOf(spread.right)
            const srcL = await spread.left?.load?.()
            const srcR = await spread.right?.load?.()
            const left = { index: indexL, src: srcL }
            const right = { index: indexR, src: srcR }
            await this.#showSpread({ left, right, side })
        }
        this.#reportLocation(reason)
    }
    async select(target) {
        await this.goTo({ ...await target, select: true })
    }
    async goTo(target) {
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        const hasFocus = this.getContents().some(({ doc }) => doc.hasFocus())
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
        const frame = this.getContents().find(frame => frame.index === resolved.index)
        if (!frame || this.index !== resolved.index) return
        const { doc } = frame
        if (hasFocus) doc.defaultView.focus()
        const anchor = typeof resolved.anchor === 'function' ? resolved.anchor(doc) : resolved.anchor
        this.scrollToAnchor(anchor, resolved.select)
    }
    scrollToAnchor(anchor, select) {
        const node = anchor?.startContainer ?? anchor
        const doc = node?.ownerDocument
        if (!doc) return
        if (!select && doc.hasFocus()) {
            const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
            if (el?.focus && el.getClientRects().length) {
                if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) {
                    el.setAttribute('tabindex', '-1')
                    el.addEventListener('blur', () => {
                        if (el.getAttribute('tabindex') === '-1') el.removeAttribute('tabindex')
                    }, { once: true })
                }
                el.focus({ preventScroll: true })
            }
        }
        if (select) {
            const range = doc.createRange()
            if (anchor.startContainer) {
                range.setStart(anchor.startContainer, anchor.startOffset)
                range.setEnd(anchor.endContainer, anchor.endOffset)
            } else range.selectNodeContents(anchor)
            const selection = doc.getSelection()
            selection.removeAllRanges()
            selection.addRange(range)
        }
        const rect = anchor.getBoundingClientRect?.()
        const iframe = doc.defaultView?.frameElement
        if (!rect || !iframe) return
        const frameRect = iframe.getBoundingClientRect()
        const scale = frameRect.width / iframe.clientWidth
        const viewport = this.getBoundingClientRect()
        const left = frameRect.left + rect.left * scale
        const top = frameRect.top + rect.top * scale
        const dx = left < viewport.left ? left - viewport.left
            : Math.max(0, left + rect.width * scale - viewport.right)
        const dy = top < viewport.top ? top - viewport.top
            : Math.max(0, top + rect.height * scale - viewport.bottom)
        this.scrollBy(dx, dy)
    }
    async next() {
        const s = await (this.rtl ? this.#goLeft() : this.#goRight())
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev() {
        const s = await (this.rtl ? this.#goRight() : this.#goLeft())
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    getContents() {
        const frames = this.#center ? [this.#center] : [this.#left, this.#right]
        return frames.filter(frame => frame && !frame.blank).map(frame => ({
            index: frame.index,
            doc: frame.iframe.contentDocument,
            overlayer: frame.overlayer,
        }))
    }
    destroy() {
        this.#observer.disconnect()
        this.#root.replaceChildren()
        this.#left = this.#right = this.#center = null
    }
}

customElements.define('foliate-fxl', FixedLayout)
