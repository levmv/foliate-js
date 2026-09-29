import { withAbort, throwIfAborted } from './resource-wait.js'

// Owns section loads and views; the paginator controls layout and eviction.
// Source loading is serial because chapters can share resources.
export class SectionWindow {
    #records = []
    #loading = Promise.resolve()
    constructor({ sections, create, load, unload }) {
        this.sections = sections
        this.create = create
        this.loadView = load
        this.unload = unload
    }
    get records() { return this.#records }
    get(index) { return this.#records.find(record => record.index === index) }
    load(index) {
        const existing = this.get(index)
        if (existing) return existing.promise
        const record = { index, view: this.create(index), controller: new AbortController() }
        this.#records.push(record)
        this.#records.sort((a, b) => a.index - b.index)
        const { signal } = record.controller
        const source = this.#loading.then(async () => {
            throwIfAborted(signal)
            const src = await this.sections[index].load()
            record.loaded = true
            if (signal.aborted) this.#release(record)
            throwIfAborted(signal)
            if (!src) throw new Error(`Failed to load section ${index}`)
            return src
        })
        this.#loading = source.catch(() => {})
        record.promise = withAbort(source, signal).then(async src => {
            await withAbort(this.loadView(record, src), signal)
            throwIfAborted(signal)
            record.ready = true
            return record
        }).catch(error => {
            this.remove(record)
            throw error
        })
        return record.promise
    }
    #release(record) {
        if (!record.loaded || record.released) return
        record.released = true
        this.sections[record.index].unload?.()
    }
    remove(record) {
        const position = this.#records.indexOf(record)
        if (position < 0) return
        this.#records.splice(position, 1)
        record.controller.abort()
        this.unload(record)
        this.#release(record)
    }
    clear(keep) {
        for (const record of [...this.#records])
            if (record !== keep) this.remove(record)
    }
}
