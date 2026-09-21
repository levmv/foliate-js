// Transform markup without rewriting examples, comments, declarations, or code.
const rewriteMarkup = (str, text, tag) => {
    const out = []
    let offset = 0
    while (offset < str.length) {
        const start = str.indexOf('<', offset)
        if (start < 0) { out.push(text(str.slice(offset))); break }
        out.push(text(str.slice(offset, start)))
        let end
        for (const [open, close] of [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?', '?>']]) {
            if (!str.startsWith(open, start)) continue
            const index = str.indexOf(close, start + open.length)
            end = index < 0 ? str.length : index + close.length
            break
        }
        if (end != null) {
            out.push(str.slice(start, end))
            offset = end
            continue
        }
        let quote = '', brackets = 0
        const declaration = str[start + 1] === '!'
        for (end = start + 1; end < str.length; end++) {
            const char = str[end]
            if (quote) { if (char === quote) quote = '' }
            else if (char === '"' || char === "'") quote = char
            else if (declaration && char === '[') brackets++
            else if (declaration && char === ']') brackets--
            else if (char === '>' && !brackets) { end++; break }
        }
        const source = str.slice(start, end)
        const match = /^<(\/?)([\w:.-]+)(?=[\s/>])/.exec(source)
        out.push(match ? tag(source, match[2], !!match[1]) : source)
        offset = end
        // Script and style contents are not ordinary XML/HTML text.
        if (match && !match[1] && /^(script|style)$/i.test(match[2])
            && !/\/>$/.test(source)) {
            const close = new RegExp(`</${match[2]}\\s*>`, 'ig')
            close.lastIndex = offset
            const closing = close.exec(str)
            const next = closing ? closing.index : str.length
            out.push(str.slice(offset, next))
            offset = next
        }
    }
    return out.join('')
}

const voidElement = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/
const hasParseError = doc => !!doc.querySelector('parsererror')

const repairEntities = str => {
    const probe = document.createElement('div')
    const cache = new Map()
    return rewriteMarkup(str, replace, source => replace(source))
    function replace(value) {
        return value.replace(/&(?:#(?:\d+|x[\da-fA-F]+);|[a-zA-Z][a-zA-Z0-9]*;)?/g, entity => {
            if (entity === '&') return '&amp;'
            if (/^&(?:#|amp;|lt;|gt;|quot;|apos;)/.test(entity)) return entity
            if (entity.length > 34) return entity
            if (cache.has(entity)) return cache.get(entity)
            // Attribute parsing avoids HTML's partial decoding of unknown names.
            // The matched token cannot contain markup or an attribute delimiter.
            probe.innerHTML = `<span data-value="${entity}"></span>`
            const value = probe.firstElementChild.getAttribute('data-value')
            const result = value === entity ? entity
                : Array.from(value, char => `&#${char.codePointAt(0)};`).join('')
            cache.set(entity, result)
            return result
        })
    }
}

const closeVoidElements = str => {
    const paired = new Set()
    rewriteMarkup(str, value => value, (source, name, closing) => {
        if (closing) paired.add(name)
        return source
    })
    return rewriteMarkup(str, value => value, (source, name, closing) =>
        !closing && voidElement.test(name) && !paired.has(name) && !/\/>$/.test(source)
            ? source.slice(0, -1) + '/>' : source)
}

export const expandEmptyElements = str => rewriteMarkup(str, value => value,
    (source, name, closing) => !closing && /^(a|div|span|p)$/i.test(name) && /\/>$/.test(source)
        ? source.slice(0, -2) + `></${name}>` : source)

export const parseXMLDocument = (parser, str, type = 'application/xml') => {
    if (typeof str !== 'string') throw new Error('Missing document content')
    let doc = parser.parseFromString(str, type)
    if (!hasParseError(doc)) return doc
    const repaired = repairEntities(str)
    if (repaired !== str) doc = parser.parseFromString(repaired, type)
    if (hasParseError(doc) && type === 'application/xhtml+xml') {
        const closed = closeVoidElements(repaired)
        if (closed !== repaired) doc = parser.parseFromString(closed, type)
    }
    return doc
}

export const parseContentDocument = (parser, str, mediaType) => {
    let doc = mediaType === 'text/html' ? parser.parseFromString(str, mediaType)
        : parseXMLDocument(parser, str, mediaType)
    if (mediaType === 'application/xhtml+xml'
        && (hasParseError(doc) || !doc.documentElement?.namespaceURI)) {
        mediaType = 'text/html'
        doc = parser.parseFromString(expandEmptyElements(str), mediaType)
    }
    return { doc, mediaType }
}

export const serializeDocument = (doc, mediaType) => {
    const serializer = new XMLSerializer()
    if (mediaType !== 'text/html') return serializer.serializeToString(doc)
    // XML serialization escapes raw script/style text; HTML would read those
    // escapes literally. Keep the doctype as well as the HTML element.
    return Array.from(doc.childNodes, node => node.nodeType === Node.ELEMENT_NODE
        ? node.outerHTML : serializer.serializeToString(node)).join('')
}
